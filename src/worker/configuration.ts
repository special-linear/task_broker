import { z } from "zod";
import {
  AppError,
  assert,
  DEFAULTS,
  effectivePolicy,
  fieldSchema,
  idSchema,
  json,
  policySchema,
  randomSecret,
  sha256,
  validate,
  validateFields,
  VERSION,
} from "../shared/core";
import { familySchema, mutation, poolSchema, profileSchema } from "../shared/contracts";
import { compileFilter, parseFilter } from "../shared/filter";
import {
  all,
  audit,
  beginReceipt,
  commitReceipt,
  configGuard,
  DB_NOW,
  effectiveHeads,
  one,
  stmt,
  type Receipt,
} from "./db";
import { fieldsFor, resolverFor } from "./model";
import type { Context, Row } from "./types";

export async function bootstrap(c: Context) {
  assert(
    c.actor.kind === "admin" && c.actor.owner,
    "FORBIDDEN",
    "Only a deployment owner may initialize this installation.",
    403,
  );
  const body = validate(mutation.strict(), c.body),
    r = await beginReceipt(c.env, c.actor, "bootstrap", "installation", body, {
      epoch: false,
      maintenance: true,
    });
  if (!r.existing) {
    r.statements.push(
      stmt(
        c.env.DB,
        `UPDATE installation SET active_epoch=?,setup_status='ready',maintenance=0,created_at=${DB_NOW},updated_at=${DB_NOW} WHERE id=1 AND setup_status='closed'`,
        c.env.INSTANCE_EPOCH,
      ),
    );
    audit(r, "installation", "1", { initialized: true });
  }
  return JSON.parse((await commitReceipt(r, { ready: true })).receipt.metadata_json);
}
export async function createFamily(c: Context) {
  const body = validate(familySchema, c.body),
    r = await beginReceipt(c.env, c.actor, "family.create", "families", body),
    id = crypto.randomUUID();
  if (!r.existing) {
    effectivePolicy(body.policy);
    raiseReceiptRetention(r, body.policy);
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO families(id,slug,name,description,policy_json,created_at) VALUES(?,?,?,?,?,${DB_NOW})`,
        id,
        body.slug,
        body.name,
        body.description,
        json(body.policy),
      ),
    );
    audit(r, "family", id, { created: body.name });
  }
  return JSON.parse((await commitReceipt(r, { id })).receipt.metadata_json);
}
export async function createPool(c: Context) {
  const body = validate(poolSchema, c.body),
    r = await beginReceipt(c.env, c.actor, "pool.create", "pools", body),
    id = crypto.randomUUID(),
    profile = crypto.randomUUID();
  if (!r.existing) {
    validateFields(body.fields);
    const family = await one(c.env.DB, "SELECT * FROM families WHERE id=?", body.family_id);
    assert(family, "NOT_FOUND", "Family not found.", 404);
    assert(
      !family.archived_at,
      "INVALID_VALUE",
      "Restore this family before creating a pool in it.",
    );
    const fields = body.fields.map((f, i) => ({
      ...f,
      id: f.id ?? crypto.randomUUID(),
      position: i,
    }));
    const slug =
      body.profile_slug ??
      (body.name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/^-+/, "")
        .slice(0, 48) ||
        id.slice(0, 8));
    const exists = await one(
      c.env.DB,
      "SELECT id FROM profiles WHERE family_id=? AND slug=? UNION ALL SELECT profile_id FROM profile_aliases WHERE route=? LIMIT 1",
      family.id,
      slug,
      `${family.slug}/${slug}`,
    );
    assert(
      !body.profile_slug || !exists,
      "INVALID_VALUE",
      "This route suffix is already used in this family. Choose another suffix.",
    );
    configGuard(r, [{ table: "families", id: family.id, revision: family.config_revision }]);
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO pools(id,owner_family_id,name,description,enabled,created_at) VALUES(?,?,?,?,?,${DB_NOW})`,
        id,
        family.id,
        body.name,
        body.description,
        body.enabled,
      ),
    );
    r.statements.push(fieldInsert(c, fields, id));
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO schema_versions(pool_id,version,fields_json,created_at) VALUES(?,1,?,${DB_NOW})`,
        id,
        json(fields),
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO profiles(id,family_id,pool_id,slug,name,filter_allowlist_json,created_at) VALUES(?,?,?,?,?,?,${DB_NOW})`,
        profile,
        family.id,
        id,
        exists ? `${slug}-${id.slice(0, 6)}` : slug,
        body.name,
        json([
          ...fields.filter((f) => f.kind === "input").map((f) => f.key),
          "task_id",
          "enabled",
          "attempts",
          "attempts_total",
          "status",
          "status_total",
        ]),
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE families SET default_profile_id=COALESCE(default_profile_id,?),config_revision=config_revision+1 WHERE id=?",
        profile,
        family.id,
      ),
    );
    audit(r, "pool", id, { created: body.name });
  }
  return JSON.parse((await commitReceipt(r, { id, profile_id: profile })).receipt.metadata_json);
}
export function fieldInsert(c: Context, fields: unknown[], pool: string) {
  return stmt(
    c.env.DB,
    `INSERT INTO pool_fields(id,pool_id,kind,key,label,type,required,nullable,default_json,pointer,position,active) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.kind'),json_extract(value,'$.key'),json_extract(value,'$.label'),json_extract(value,'$.type'),json_extract(value,'$.required'),json_extract(value,'$.nullable'),CASE WHEN json_type(value,'$.default') IS NULL THEN NULL ELSE value -> '$.default' END,json_extract(value,'$.pointer'),json_extract(value,'$.position'),json_extract(value,'$.active') FROM json_each(?)`,
    pool,
    json(fields),
  );
}
export async function createProfile(c: Context) {
  const body = validate(profileSchema, c.body),
    r = await beginReceipt(c.env, c.actor, "profile.create", "profiles", body),
    id = crypto.randomUUID();
  if (!r.existing) {
    const family = await one(c.env.DB, "SELECT * FROM families WHERE id=?", body.family_id);
    const pool = await one(c.env.DB, "SELECT * FROM pools WHERE id=?", body.pool_id);
    assert(family && pool, "NOT_FOUND", "Family or pool not found.", 404);
    assert(
      !family.archived_at && !pool.archived_at,
      "INVALID_VALUE",
      "Restore the family and pool before creating a profile.",
    );
    assert(
      !(await one(
        c.env.DB,
        "SELECT id FROM profiles WHERE family_id=? AND slug=? UNION ALL SELECT profile_id FROM profile_aliases WHERE route=? LIMIT 1",
        body.family_id,
        body.slug,
        `${family.slug}/${body.slug}`,
      )),
      "INVALID_VALUE",
      "This route suffix is already used in this family. Choose another suffix.",
    );
    configGuard(r, [
      { table: "families", id: family.id, revision: family.config_revision },
      { table: "pools", id: pool.id, revision: pool.config_revision },
    ]);
    assert(
      !Object.hasOwn(body.policy, "family_cap") && !Object.hasOwn(body.policy, "worker_family_cap"),
      "INVALID_VALUE",
      "Family-wide caps must be configured on the family, not an individual profile.",
    );
    const fields = await fieldsFor(c.env, body.pool_id);
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE requests SET guard_config=(SELECT migration_status='ready' FROM pools WHERE id=?) WHERE uid=?",
        body.pool_id,
        r.uid,
      ),
    );
    compileFilter(parseFilter(body.mandatory_filter), resolverFor(fields, id));
    const resolve = resolverFor(fields, id);
    for (const f of body.filter_allowlist) resolve(f);
    for (const f of body.projection ?? [])
      assert(
        fields.some((x) => x.kind === "input" && x.key === f),
        "UNKNOWN_FIELD",
        `Unknown projected input: ${f}`,
      );
    effectivePolicy(body.policy);
    raiseReceiptRetention(r, body.policy);
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO profiles(id,family_id,pool_id,slug,name,policy_json,mandatory_filter,projection_json,filter_allowlist_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,${DB_NOW})`,
        id,
        body.family_id,
        body.pool_id,
        body.slug,
        body.name,
        json(body.policy),
        body.mandatory_filter,
        body.projection === null ? null : json(body.projection),
        json(body.filter_allowlist),
      ),
    );
    audit(r, "profile", id, { created: body.name });
  }
  return JSON.parse((await commitReceipt(r, { id })).receipt.metadata_json);
}
function raiseReceiptRetention(r: Receipt, policy: { max_lifetime_seconds?: number }) {
  if (policy.max_lifetime_seconds !== undefined)
    r.statements.push(
      stmt(
        r.env.DB,
        "UPDATE installation SET receipt_retention_ms=max(receipt_retention_ms,?) WHERE id=1",
        (policy.max_lifetime_seconds + 86400) * 1000,
      ),
    );
}
export const configPatch = mutation
  .extend({
    expected_revision: z.number().int().positive(),
    patch: z
      .object({
        name: idSchema.optional(),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
        archived: z.boolean().optional(),
        policy: policySchema.optional(),
        default_profile_id: z.string().uuid().nullable().optional(),
        active_cap: z.number().int().nonnegative().nullable().optional(),
        total_attempt_cap: z.number().int().nonnegative().nullable().optional(),
        required_result: z.boolean().optional(),
        mandatory_filter: z.string().optional(),
        projection: z.array(z.string()).nullable().optional(),
        filter_allowlist: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();
export async function updateConfiguration(
  c: Context,
  table: "families" | "pools" | "profiles",
  id: string,
) {
  const body = validate(configPatch, c.body),
    r = await beginReceipt(c.env, c.actor, `${table}.update`, id, body);
  if (!r.existing) {
    const current = await one(c.env.DB, `SELECT * FROM ${table} WHERE id=?`, id);
    assert(current, "NOT_FOUND", "Configuration not found.", 404);
    configGuard(r, [{ table, id, revision: body.expected_revision }]);
    const allowed =
      table === "families"
        ? ["name", "description", "enabled", "policy", "default_profile_id", "archived"]
        : table === "pools"
          ? [
              "name",
              "description",
              "enabled",
              "archived",
              "active_cap",
              "total_attempt_cap",
              "required_result",
            ]
          : [
              "name",
              "enabled",
              "archived",
              "policy",
              "mandatory_filter",
              "projection",
              "filter_allowlist",
            ];
    for (const k of Object.keys(body.patch))
      assert(allowed.includes(k), "INVALID_VALUE", `${k} is not an editable ${table} property.`);
    assert(
      !body.patch.enabled || !(body.patch.archived ?? !!current.archived_at),
      "INVALID_VALUE",
      "Restore this archived item before enabling it.",
    );
    if (body.patch.policy) {
      effectivePolicy(body.patch.policy);
      raiseReceiptRetention(r, body.patch.policy);
    }
    if (table === "profiles") {
      assert(
        !body.patch.policy ||
          (!Object.hasOwn(body.patch.policy, "family_cap") &&
            !Object.hasOwn(body.patch.policy, "worker_family_cap")),
        "INVALID_VALUE",
        "Configure family-wide caps on the family.",
      );
      r.statements.push(
        stmt(
          c.env.DB,
          "UPDATE requests SET guard_config=(SELECT migration_status='ready' FROM pools WHERE id=?) WHERE uid=?",
          current.pool_id,
          r.uid,
        ),
      );
      const fields = await fieldsFor(c.env, current.pool_id);
      if (body.patch.mandatory_filter !== undefined)
        compileFilter(parseFilter(body.patch.mandatory_filter), resolverFor(fields, id));
      for (const f of body.patch.filter_allowlist ?? []) resolverFor(fields, id)(f);
      for (const f of body.patch.projection ?? [])
        assert(
          fields.some((x) => x.kind === "input" && x.key === f),
          "UNKNOWN_FIELD",
          `Unknown projected field: ${f}`,
        );
    }
    if (body.patch.default_profile_id) {
      assert(
        await one(
          c.env.DB,
          "SELECT id FROM profiles WHERE id=? AND family_id=?",
          body.patch.default_profile_id,
          id,
        ),
        "INVALID_VALUE",
        "The default profile must belong to this family.",
      );
      r.statements.push(
        stmt(
          c.env.DB,
          "UPDATE requests SET guard_config=EXISTS(SELECT 1 FROM profiles WHERE id=? AND family_id=?) WHERE uid=?",
          body.patch.default_profile_id,
          id,
          r.uid,
        ),
      );
    }
    const sets: string[] = [],
      args: unknown[] = [];
    for (const [k, v] of Object.entries(body.patch)) {
      if (k === "archived") {
        sets.push(`archived_at=${v ? DB_NOW : "NULL"}`);
        if (v) sets.push("enabled=0");
      } else if (["policy", "projection", "filter_allowlist"].includes(k)) {
        sets.push(
          `${k === "policy" ? "policy_json" : k === "projection" ? "projection_json" : "filter_allowlist_json"}=?`,
        );
        args.push(v === null ? null : json(v));
      } else {
        sets.push(`${k}=?`);
        args.push(v);
      }
    }
    r.statements.push(
      stmt(
        c.env.DB,
        `UPDATE ${table} SET ${[...sets, "config_revision=config_revision+1"].join(",")} WHERE id=?`,
        ...args,
        id,
      ),
    );
    audit(r, table, id, {
      before_revision: body.expected_revision,
      patch: body.patch,
    });
  }
  return JSON.parse(
    (
      await commitReceipt(r, {
        id,
        config_revision: body.expected_revision + 1,
      })
    ).receipt.metadata_json,
  );
}
export async function keyAction(c: Context, id?: string, action?: string) {
  const creation = !id || action === "rotate";
  const schema = creation
    ? mutation.extend({ family_id: z.string().uuid().optional(), label: idSchema }).strict()
    : mutation.extend({ reason: z.string().min(1) }).strict();
  const body = validate(schema as z.ZodType<any>, c.body),
    r = await beginReceipt(
      c.env,
      c.actor,
      `key.${action ?? "create"}`,
      id ?? body.family_id,
      body,
      { maintenance: action === "hard-revoke" && c.actor.kind === "admin" && c.actor.owner },
    ),
    newId = crypto.randomUUID();
  let secret: string | undefined;
  if (!r.existing) {
    const old = id ? await one(c.env.DB, "SELECT * FROM api_keys WHERE id=?", id) : null;
    if (id) assert(old, "NOT_FOUND", "Key not found.", 404);
    if (creation) {
      secret = randomSecret();
      const family = old?.family_id ?? body.family_id;
      assert(family, "INVALID_VALUE", "A family is required.");
      r.statements.push(
        stmt(
          c.env.DB,
          `INSERT INTO api_keys(id,family_id,label,prefix,secret_digest,issued_at) VALUES(?,?,?,?,?,${DB_NOW})`,
          newId,
          family,
          body.label,
          `tb_${newId.slice(0, 8)}`,
          await sha256(secret),
        ),
      );
    }
    if (id) {
      assert(
        ["rotate", "soft-revoke", "hard-revoke"].includes(action!),
        "INVALID_VALUE",
        "Unknown key action.",
      );
      r.statements.push(
        stmt(
          c.env.DB,
          `UPDATE api_keys SET status=?,revoked_at=${DB_NOW} WHERE id=? AND status!='hard_revoked'`,
          action === "hard-revoke" ? "hard_revoked" : "soft_revoked",
          id,
        ),
      );
    }
    audit(
      r,
      "key",
      creation ? newId : id!,
      { action: action ?? "create", label: creation ? body.label : undefined },
      body.reason,
    );
  }
  const result = await commitReceipt(
    r,
    creation
      ? { id: newId, label: body.label, secret_available: false }
      : {
          id,
          status: action === "hard-revoke" ? "hard_revoked" : "soft_revoked",
        },
  );
  return {
    ...JSON.parse(result.receipt.metadata_json),
    ...(secret && !result.replayed ? { key: `tb_${newId}_${secret}`, secret_available: true } : {}),
  };
}
export async function installationAction(c: Context, action: string) {
  assert(
    c.actor.kind === "admin" && c.actor.owner,
    "FORBIDDEN",
    "A deployment owner is required.",
    403,
  );
  const body = validate(
    mutation
      .extend({
        maintenance: z.boolean().optional(),
        expected_revision: z.number().int().positive().optional(),
        defaults: policySchema.optional(),
        reason: z.string().optional(),
      })
      .strict(),
    c.body,
  );
  const r = await beginReceipt(c.env, c.actor, `installation.${action}`, "installation", body, {
    maintenance: action === "maintenance" || action === "epoch",
    epoch: action !== "epoch",
  });
  if (!r.existing) {
    if (action === "maintenance") {
      assert(
        typeof body.maintenance === "boolean",
        "INVALID_VALUE",
        "Specify maintenance true or false.",
      );
      r.statements.push(
        stmt(
          c.env.DB,
          `UPDATE installation SET maintenance=?,updated_at=${DB_NOW} WHERE id=1`,
          body.maintenance,
        ),
      );
    } else if (action === "epoch") {
      r.statements.push(
        stmt(
          c.env.DB,
          "UPDATE requests SET guard_maintenance=(SELECT maintenance=1 FROM installation WHERE id=1) WHERE uid=?",
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          c.env.DB,
          `UPDATE installation SET active_epoch=?,updated_at=${DB_NOW} WHERE id=1`,
          c.env.INSTANCE_EPOCH,
        ),
      );
    } else if (action === "settings") {
      assert(
        body.defaults && body.expected_revision,
        "INVALID_VALUE",
        "Defaults and expected_revision are required.",
      );
      effectivePolicy(body.defaults);
      raiseReceiptRetention(r, body.defaults);
      configGuard(r, [{ table: "installation", id: "1", revision: body.expected_revision }]);
      r.statements.push(
        stmt(
          c.env.DB,
          `UPDATE installation SET defaults_json=?,config_revision=config_revision+1,updated_at=${DB_NOW} WHERE id=1`,
          json(body.defaults),
        ),
      );
    } else throw new AppError("NOT_FOUND", "Unknown installation action.", 404);
    audit(
      r,
      "installation",
      "1",
      { action, ...body, request_id: undefined, request_created_at: undefined },
      body.reason,
    );
  }
  return JSON.parse((await commitReceipt(r, { updated: true })).receipt.metadata_json);
}
export async function administratorAction(c: Context, subject?: string) {
  const body = validate(
      mutation
        .extend({
          subject: z.string().min(1).optional(),
          email: z.email().optional(),
          active: z.boolean().default(true),
        })
        .strict(),
      c.body,
    ),
    id = subject ?? body.subject;
  assert(id, "INVALID_VALUE", "The Access subject is required.");
  const r = await beginReceipt(c.env, c.actor, "administrator.update", id, body);
  if (!r.existing) {
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO administrators(subject,email,active,created_at) VALUES(?,?,?,${DB_NOW}) ON CONFLICT(subject) DO UPDATE SET email=excluded.email,active=excluded.active`,
        id,
        body.email ?? "",
        body.active,
      ),
    );
    audit(r, "administrator", id, { email: body.email, active: body.active });
  }
  return JSON.parse((await commitReceipt(r, { subject: id })).receipt.metadata_json);
}
export async function diagnostics(c: Context) {
  const install = (await one(c.env.DB, "SELECT * FROM installation WHERE id=1"))!;
  const counts = await one(
    c.env.DB,
    `SELECT (SELECT COUNT(*) FROM tasks) tasks,(SELECT COUNT(*) FROM attempts) attempts,(SELECT COUNT(*) FROM (${effectiveHeads(DB_NOW, "(SELECT active_epoch FROM installation WHERE id=1)")})) active_leases,(SELECT COUNT(*) FROM requests) receipts`,
  );
  // Remote D1 disallows page_count/page_size PRAGMAs. Native query metadata
  // provides the database size without privileged SQLite introspection.
  const size = await stmt(c.env.DB, "SELECT id FROM installation WHERE id=1").all();
  return {
    version: VERSION,
    schema_version: install.schema_version,
    config_revision: install.config_revision,
    setup_status: install.setup_status,
    maintenance: !!install.maintenance,
    epoch_matches: install.active_epoch === c.env.INSTANCE_EPOCH,
    environment: c.env.ENVIRONMENT,
    admin_origin: c.env.ADMIN_ORIGIN,
    broker_hostname: c.env.BROKER_HOSTNAME,
    counts,
    estimated_bytes: size.meta.size_after ?? 0,
    defaults: effectivePolicy(JSON.parse(install.defaults_json)),
    sampled_at: new Date().toISOString(),
  };
}
