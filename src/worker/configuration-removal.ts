import { assert, json, sha256, validate } from "../shared/core";
import { configurationRemovalSchema } from "../shared/contracts";
import { sqlString } from "../shared/filter";
import { audit, beginReceipt, commitReceipt, configGuard, one, stmt } from "./db";
import { physicalIndexName } from "./sort-indexes";
import type { Context } from "./types";

export type ConfigurationTable = "families" | "pools" | "profiles";

// The same dependency queries power the review and the transactional delete guard.
// Audit events and administrator request receipts intentionally survive deletion.
async function removalPlan(c: Context, table: ConfigurationTable, id: string) {
  const row = await one(c.env.DB, `SELECT * FROM ${table} WHERE id=?`, id);
  assert(row, "NOT_FOUND", "Configuration not found.", 404);
  const value = sqlString(id);
  const profileScope = table === "pools" ? `pool_id=${value}` : `id=${value}`;
  const profileIds = `SELECT id FROM profiles WHERE ${profileScope}`;
  const checks: [string, string][] =
    table === "families"
      ? [
          [
            "Owned pools must be deleted or kept with this archived family.",
            `SELECT 1 FROM pools WHERE owner_family_id=${value}`,
          ],
          [
            "Profiles still belong to this family.",
            `SELECT 1 FROM profiles WHERE family_id=${value}`,
          ],
          [
            "Attempt history belongs to this family.",
            `SELECT 1 FROM attempts WHERE family_id=${value}`,
          ],
          [
            "Lease records belong to this family.",
            `SELECT 1 FROM lease_heads WHERE family_id=${value}`,
          ],
          [
            "Revoke this family's API keys permanently before deleting it.",
            `SELECT 1 FROM api_keys WHERE family_id=${value} AND status!='hard_revoked'`,
          ],
        ]
      : [
          ...(table === "pools"
            ? ([
                [
                  "The pool contains tasks, including any deleted tasks retained in history.",
                  `SELECT 1 FROM tasks WHERE pool_id=${value}`,
                ],
                [
                  "Finish the pool's schema migration before deleting it.",
                  `SELECT 1 FROM pools WHERE id=${value} AND migration_status!='ready'`,
                ],
              ] as [string, string][])
            : []),
          [
            "Attempt history uses this pool or profile.",
            `SELECT 1 FROM attempts WHERE profile_id IN (${profileIds})${table === "pools" ? ` OR pool_id=${value}` : ""}`,
          ],
          [
            "Task attempt counters or imported history use this profile.",
            `SELECT 1 FROM task_profile_state WHERE profile_id IN (${profileIds})`,
          ],
          [
            "Lease records use this pool or profile.",
            `SELECT 1 FROM lease_heads WHERE profile_id IN (${profileIds})${table === "pools" ? ` OR pool_id=${value}` : ""}`,
          ],
          [
            "Saved views reference this pool or profile. Remove those views first, or archive this item.",
            `SELECT 1 FROM saved_views WHERE profile_id IN (${profileIds})${table === "pools" ? ` OR pool_id=${value}` : ""}`,
          ],
          [
            "Reviewed operations or import/export history reference this pool or profile.",
            `SELECT 1 FROM admin_operations WHERE profile_id IN (${profileIds})${table === "pools" ? ` OR pool_id=${value}` : ""}`,
          ],
          [
            "Recent worker requests still reference this profile.",
            `SELECT 1 FROM requests WHERE scope IN (${profileIds}) AND action IN ('claim','report','renew')`,
          ],
        ];
  const snapshots: Record<string, string> = {};
  if (table !== "families") {
    snapshots.profiles = `SELECT COALESCE(json_group_array(json_object('id',id,'family_id',family_id,'name',name,'slug',slug,'revision',config_revision)),'[]') FROM (SELECT * FROM profiles WHERE ${profileScope} ORDER BY id)`;
    snapshots.defaults = `SELECT COALESCE(json_group_array(json_object('id',id,'name',name,'slug',slug,'revision',config_revision)),'[]') FROM (SELECT * FROM families WHERE default_profile_id IN (${profileIds}) ORDER BY id)`;
  } else {
    snapshots.keys = `SELECT COALESCE(json_group_array(json_object('id',id,'status',status)),'[]') FROM (SELECT * FROM api_keys WHERE family_id=${value} ORDER BY id)`;
  }
  if (table === "pools") {
    snapshots.indexes = `SELECT COALESCE(json_group_array(json_object('id',id,'revision',revision)),'[]') FROM (SELECT * FROM claim_sort_indexes WHERE pool_id=${value} ORDER BY id)`;
  }
  const blocked = checks.map(([, query]) => `EXISTS(${query})`);
  const current = (await one(
    c.env.DB,
    `SELECT ${[
      ...blocked.map((query, i) => `${query} blocked_${i}`),
      ...Object.entries(snapshots).map(([name, query]) => `(${query}) ${name}`),
    ].join(",")}`,
  ))!;
  const dependencies = Object.fromEntries(
    Object.keys(snapshots).map((name) => [name, current[name]]),
  );
  const reasons = checks.flatMap(([reason], i) => (current[`blocked_${i}`] ? [reason] : []));
  const review = {
    id,
    name: row.name,
    expected_revision: row.config_revision,
    dependency_token: await sha256(json(dependencies)),
    can_delete: reasons.length === 0,
    reasons,
    profiles: JSON.parse(current.profiles ?? "[]"),
    defaults: JSON.parse(current.defaults ?? "[]"),
    revoked_key_count: JSON.parse(current.keys ?? "[]").length,
  };
  return { row, review, checks, snapshots, current, profileIds };
}

export async function reviewConfigurationRemoval(
  c: Context,
  table: ConfigurationTable,
  id: string,
) {
  return (await removalPlan(c, table, id)).review;
}

export async function deleteConfiguration(c: Context, table: ConfigurationTable, id: string) {
  const body = validate(configurationRemovalSchema, c.body);
  const r = await beginReceipt(c.env, c.actor, `${table}.delete`, id, body);
  if (r.existing) return JSON.parse((await commitReceipt(r)).receipt.metadata_json);
  const plan = await removalPlan(c, table, id);
  assert(plan.review.can_delete, "CONFIG_CHANGED", plan.review.reasons.join(" "), 409);
  assert(
    body.dependency_token === plan.review.dependency_token,
    "CONFIG_CHANGED",
    "Dependencies changed. Review deletion again.",
    409,
  );
  configGuard(r, [{ table, id, revision: body.expected_revision }]);
  r.statements.push(
    stmt(
      c.env.DB,
      `UPDATE requests SET guard_config=(${[
        ...plan.checks.map(([, query]) => `NOT EXISTS(${query})`),
        ...Object.values(plan.snapshots).map((query) => `(${query})=?`),
      ].join(" AND ")}) WHERE uid=?`,
      ...Object.keys(plan.snapshots).map((name) => plan.current[name]),
      r.uid,
    ),
  );
  if (table !== "families") {
    r.statements.push(
      stmt(
        c.env.DB,
        `UPDATE families SET default_profile_id=NULL,config_revision=config_revision+1 WHERE default_profile_id IN (${plan.profileIds})`,
      ),
    );
    r.statements.push(
      stmt(c.env.DB, `DELETE FROM profile_aliases WHERE profile_id IN (${plan.profileIds})`),
    );
    r.statements.push(stmt(c.env.DB, `DELETE FROM profiles WHERE id IN (${plan.profileIds})`));
  } else {
    r.statements.push(stmt(c.env.DB, "DELETE FROM api_keys WHERE family_id=?", id));
  }
  if (table === "pools") {
    for (const index of JSON.parse(plan.current.indexes))
      r.statements.push(stmt(c.env.DB, `DROP INDEX IF EXISTS ${physicalIndexName(index.id)}`));
    for (const child of ["claim_sort_indexes", "pool_fields", "schema_versions"])
      r.statements.push(stmt(c.env.DB, `DELETE FROM ${child} WHERE pool_id=?`, id));
  }
  if (table !== "profiles")
    r.statements.push(stmt(c.env.DB, `DELETE FROM ${table} WHERE id=?`, id));
  audit(r, table, id, {
    deleted: plan.row.name,
    profiles: plan.review.profiles.map((p: { id: string }) => p.id),
  });
  return JSON.parse((await commitReceipt(r, { id, deleted: true })).receipt.metadata_json);
}
