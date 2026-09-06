import { z } from "zod";
import { assert, canonical, json, validate, type Field } from "../shared/core";
import { mutation } from "../shared/contracts";
import { sqlString } from "../shared/filter";
import { resolveSorts, sortOrder, sortSchema, sortSpec, type SortSpec } from "../shared/sort";
import {
  all,
  audit,
  beginReceipt,
  commitReceipt,
  configGuard,
  DB_NOW,
  one,
  stmt,
  type Receipt,
} from "./db";
import { fieldsFor } from "./model";
import { sortResolver } from "./sorting";
import type { Context } from "./types";
import { recordDto } from "./presentation";

export const indexCreateSchema = mutation
  .extend({ name: z.string().trim().min(1).max(128), sorts: sortSchema.min(1) })
  .strict();
export const indexChangeSchema = mutation
  .extend({ expected_revision: z.number().int().positive() })
  .strict();
const direct = new Set(["task_id", "enabled", "admin_note", "attempts_total"]);
export function physicalIndexName(id: string): string {
  assert(z.string().uuid().safeParse(id).success, "INVALID_VALUE", "Invalid sort index ID.");
  return "claim_sort_" + id.replaceAll("-", "");
}
export function indexDefinition(fields: Field[], spec: SortSpec) {
  const sorts = resolveSorts(spec, sortResolver(fields, null, undefined, ""));
  const dependencies = sorts.flatMap((s) => {
    const f = fields.find((f) => f.active && f.key === s.key);
    assert(
      f ? f.kind === "input" : direct.has(s.key),
      "INVALID_VALUE",
      "Indexes support scalar inputs and direct task columns only.",
    );
    return f ? [{ id: f.id, key: f.key, type: f.type, kind: f.kind, active: f.active }] : [];
  });
  return {
    sorts: sortSpec(sorts),
    dependencies,
    order: sortOrder(sorts, "task_id COLLATE BINARY,task_uid"),
  };
}
export function indexSQL(id: string, poolId: string, order: string): string {
  return `CREATE INDEX ${physicalIndexName(id)} ON tasks(pool_id,${order}) WHERE pool_id=${sqlString(poolId)} AND deleted_at IS NULL AND completed_at IS NULL AND enabled=1 AND valid=1`;
}
export async function listSortIndexes(c: Context, poolId: string) {
  const rows = await all(
    c.env.DB,
    "SELECT * FROM claim_sort_indexes WHERE pool_id=? ORDER BY name,id",
    poolId,
  );
  return { rows: rows.map((r) => ({ ...recordDto(r), sorts: JSON.parse(r.sorts_json) })) };
}
export async function createSortIndex(c: Context, poolId: string) {
  const body = validate(indexCreateSchema, c.body),
    r = await beginReceipt(c.env, c.actor, "claim_sort.create", poolId, body);
  if (r.existing) return JSON.parse((await commitReceipt(r)).receipt.metadata_json);
  const pool = await one(c.env.DB, "SELECT * FROM pools WHERE id=?", poolId);
  assert(pool, "NOT_FOUND", "Pool not found.", 404);
  assert(
    pool.migration_status === "ready",
    "CONFIG_CHANGED",
    "Finish the schema migration first.",
    409,
  );
  const count = await one(
    c.env.DB,
    "SELECT count(*) n FROM claim_sort_indexes WHERE pool_id=?",
    poolId,
  );
  assert(
    count!.n < 4,
    "INVALID_VALUE",
    "At most four claim sort indexes can be configured per pool.",
  );
  assert(
    !(await one(
      c.env.DB,
      "SELECT id FROM claim_sort_indexes WHERE pool_id=? AND name=?",
      poolId,
      body.name,
    )),
    "INVALID_VALUE",
    "This index name is already used.",
  );
  const definition = indexDefinition(await fieldsFor(c.env, poolId), body.sorts),
    id = crypto.randomUUID();
  configGuard(r, [{ table: "pools", id: poolId, revision: pool.config_revision }]);
  r.statements.push(
    stmt(
      c.env.DB,
      "UPDATE requests SET guard_config=(SELECT count(*)<4 FROM claim_sort_indexes WHERE pool_id=?) WHERE uid=?",
      poolId,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      c.env.DB,
      `INSERT INTO claim_sort_indexes(id,pool_id,name,sorts_json,dependencies_json,index_name,created_at) VALUES(?,?,?,?,?,?,${DB_NOW})`,
      id,
      poolId,
      body.name,
      json(definition.sorts),
      json(definition.dependencies),
      physicalIndexName(id),
    ),
  );
  audit(r, "claim_sort", id, { configured: definition.sorts });
  return JSON.parse(
    (await commitReceipt(r, { id, revision: 1, status: "unbuilt" })).receipt.metadata_json,
  );
}
export async function changeSortIndex(c: Context, id: string, remove = false) {
  const body = validate(indexChangeSchema, c.body),
    r = await beginReceipt(
      c.env,
      c.actor,
      remove ? "claim_sort.delete" : "claim_sort.build",
      id,
      body,
    );
  if (r.existing) return JSON.parse((await commitReceipt(r)).receipt.metadata_json);
  const row = await one(c.env.DB, "SELECT * FROM claim_sort_indexes WHERE id=?", id);
  assert(row, "NOT_FOUND", "Sort index not found.", 404);
  assert(
    row.revision === body.expected_revision,
    "EDIT_CONFLICT",
    "The index definition changed. Reload it.",
    409,
  );
  const pool = (await one(c.env.DB, "SELECT * FROM pools WHERE id=?", row.pool_id))!;
  assert(
    pool.migration_status === "ready",
    "CONFIG_CHANGED",
    "Finish the schema migration first.",
    409,
  );
  configGuard(r, [{ table: "pools", id: pool.id, revision: pool.config_revision }]);
  r.statements.push(
    stmt(
      c.env.DB,
      "UPDATE requests SET guard_config=EXISTS(SELECT 1 FROM claim_sort_indexes WHERE id=? AND revision=?) WHERE uid=?",
      id,
      body.expected_revision,
      r.uid,
    ),
  );
  r.statements.push(stmt(c.env.DB, `DROP INDEX IF EXISTS ${physicalIndexName(id)}`));
  if (remove) r.statements.push(stmt(c.env.DB, "DELETE FROM claim_sort_indexes WHERE id=?", id));
  else {
    assert(
      row.status !== "invalid",
      "INVALID_VALUE",
      "This definition references a removed or unsupported field. Delete it and configure a new sort.",
    );
    const definition = indexDefinition(await fieldsFor(c.env, pool.id), JSON.parse(row.sorts_json));
    assert(
      canonical(definition.dependencies) === canonical(JSON.parse(row.dependencies_json)),
      "CONFIG_CHANGED",
      "Sort fields changed. Reload the definition.",
      409,
    );
    r.statements.push(stmt(c.env.DB, indexSQL(id, pool.id, definition.order)));
    r.statements.push(
      stmt(
        c.env.DB,
        `UPDATE claim_sort_indexes SET status='ready',revision=revision+1,built_at=${DB_NOW} WHERE id=?`,
        id,
      ),
    );
  }
  audit(r, "claim_sort", id, remove ? { deleted: true } : { built: true });
  return JSON.parse(
    (
      await commitReceipt(r, {
        id,
        revision: body.expected_revision + 1,
        status: remove ? "deleted" : "ready",
      })
    ).receipt.metadata_json,
  );
}

/** Runs before input rewrites, in the schema transition transaction. */
export async function invalidateSortIndexes(r: Receipt, poolId: string, next: Field[]) {
  const rows = await all(r.env.DB, "SELECT * FROM claim_sort_indexes WHERE pool_id=?", poolId);
  // Freeze the registry too: an index configured after this read must not escape invalidation.
  r.statements.push(
    stmt(
      r.env.DB,
      "UPDATE requests SET guard_config=((SELECT count(*) FROM claim_sort_indexes WHERE pool_id=?)=? AND NOT EXISTS(SELECT 1 FROM claim_sort_indexes s WHERE s.pool_id=? AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.id')=s.id AND json_extract(j.value,'$.revision')=s.revision))) WHERE uid=?",
      poolId,
      rows.length,
      poolId,
      json(rows.map((row) => ({ id: row.id, revision: row.revision }))),
      r.uid,
    ),
  );
  for (const row of rows) {
    const dependencies = JSON.parse(row.dependencies_json) as Field[],
      spec = JSON.parse(row.sorts_json) as SortSpec;
    let changed = false,
      invalid = row.status === "invalid";
    const updated = dependencies.map((old) => {
      const f = next.find((f) => f.id === old.id);
      if (!f || !f.active || f.kind !== "input" || f.type === "json") {
        changed = true;
        invalid = true;
        return old;
      }
      const dep = { id: f.id, key: f.key, type: f.type, kind: f.kind, active: f.active };
      if (canonical(dep) !== canonical(old)) changed = true;
      return dep;
    });
    if (!changed) continue;
    const remapped = spec.map((s) => {
      const old = dependencies.find((d) => d.key === s.field);
      return { ...s, field: old ? updated.find((d) => d.id === old.id)!.key : s.field };
    });
    r.statements.push(stmt(r.env.DB, `DROP INDEX IF EXISTS ${physicalIndexName(row.id)}`));
    r.statements.push(
      stmt(
        r.env.DB,
        "UPDATE claim_sort_indexes SET sorts_json=?,dependencies_json=?,status=?,revision=revision+1,built_at=NULL WHERE id=?",
        json(remapped),
        json(updated),
        invalid ? "invalid" : "unbuilt",
        row.id,
      ),
    );
  }
}
