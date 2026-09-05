import { AppError, assert, canonical, json, sha256 } from "../shared/core";
import type { Actor, Env, Row } from "./types";
export const DB_NOW =
  "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export const stmt = (db: D1Database, sql: string, ...args: unknown[]) => {
  assert(args.length <= 100, "INTERNAL_ERROR", "Database parameter budget exceeded.", 500);
  return db
    .prepare(sql)
    .bind(...args.map((v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v)));
};
export const all = async (db: D1Database, sql: string, ...args: unknown[]): Promise<Row[]> =>
  (await stmt(db, sql, ...args).all<Row>()).results;
export const one = (db: D1Database, sql: string, ...args: unknown[]) =>
  stmt(db, sql, ...args).first<Row>();
export const actorId = (actor: Actor) => `${actor.kind}:${actor.id}`;
export const effectiveHeads = (time: string, epoch: string) =>
  `SELECT h.* FROM lease_heads h JOIN tasks ht ON ht.task_uid=h.task_uid AND ht.latest_attempt_id=h.attempt_id AND ht.lease_generation=h.lease_generation JOIN pools hp ON hp.id=h.pool_id AND hp.migration_status='ready' JOIN api_keys hk ON hk.id=h.issuing_key_id WHERE h.expires_at>${time} AND h.instance_epoch=${epoch} AND hk.status!='hard_revoked'`;
export function resourceError(error: unknown): AppError | undefined {
  const message = String(error);
  if (/quota|exceed[^.]*limit|limit[^.]*exceed|free tier daily/i.test(message))
    return new AppError(
      "QUOTA_EXCEEDED",
      "The database has reached its resource allowance. Free daily quotas reset at midnight UTC. Resume the unchanged operation after quota recovery.",
      503,
      undefined,
      false,
    );
  if (/overload|busy|timeout|temporar/i.test(message))
    return new AppError(
      "BUSY",
      "The database is temporarily busy. Retry the unchanged operation.",
      503,
      undefined,
      true,
    );
  return undefined;
}
export type Receipt = {
  uid: string;
  fingerprint: string;
  existing: Row | null;
  statements: D1PreparedStatement[];
  actor: Actor;
  body: any;
  action: string;
  scope: string;
  env: Env;
};
export async function beginReceipt(
  env: Env,
  actor: Actor,
  action: string,
  scope: string,
  body: any,
  options: {
    maintenance?: boolean;
    epoch?: boolean;
    keyActive?: boolean;
    retention?: number;
  } = {},
): Promise<Receipt> {
  const aid = actorId(actor),
    existing = await one(
      env.DB,
      "SELECT * FROM requests WHERE actor=? AND request_id=?",
      aid,
      body.request_id,
    );
  // Identical original routes continue to identify old receipts after a route rename.
  const canonicalScope = existing && existing.original_route === body.pool ? existing.scope : scope;
  const semantic = { ...body };
  delete semantic.request_id;
  delete semantic.pool;
  const fingerprint = await sha256(canonical({ action, scope: canonicalScope, ...semantic }));
  const receipt: Receipt = {
    uid: crypto.randomUUID(),
    fingerprint,
    existing,
    statements: [],
    actor,
    body,
    action,
    scope: canonicalScope,
    env,
  };
  if (existing) {
    checkReplay(receipt, existing);
    return receipt;
  }
  const retention = Math.max(172800000, options.retention ?? 0);
  const db = env.DB;
  receipt.statements.push(
    stmt(
      db,
      `INSERT INTO requests(uid,actor,request_id,action,scope,fingerprint,original_route,request_created_at,accepted_at,retention_deadline,instance_epoch) VALUES(?,?,?,?,?,?,?,?,${DB_NOW},${DB_NOW}+max(?,(SELECT receipt_retention_ms FROM installation WHERE id=1)),?)`,
      receipt.uid,
      aid,
      body.request_id,
      action,
      canonicalScope,
      fingerprint,
      body.pool ?? null,
      Date.parse(body.request_created_at),
      retention,
      env.INSTANCE_EPOCH,
    ),
  );
  const auth =
    actor.kind === "key"
      ? `EXISTS(SELECT 1 FROM api_keys WHERE id=? AND status ${options.keyActive ? "='active'" : "!='hard_revoked'"})`
      : actor.owner
        ? "1"
        : "EXISTS(SELECT 1 FROM administrators WHERE subject=? AND active=1)";
  const epoch =
    options.epoch === false
      ? "1"
      : "COALESCE((SELECT active_epoch=? FROM installation WHERE id=1),0)";
  const maintenance = options.maintenance
    ? "1"
    : "COALESCE((SELECT maintenance=0 AND setup_status='ready' FROM installation WHERE id=1),0)";
  receipt.statements.push(
    stmt(
      db,
      `UPDATE requests SET guard_fresh=(request_created_at>=accepted_at-86400000 AND request_created_at<=accepted_at+300000),guard_epoch=${epoch},guard_maintenance=${maintenance},guard_auth=${auth} WHERE uid=?`,
      ...(options.epoch === false ? [] : [env.INSTANCE_EPOCH]),
      ...(actor.kind === "admin" && actor.owner ? [] : [actor.id]),
      receipt.uid,
    ),
  );
  return receipt;
}
export function checkReplay(r: Receipt, old: Row) {
  assert(
    old.instance_epoch === r.env.INSTANCE_EPOCH,
    "INSTANCE_CHANGED",
    "This request belongs to a previous installation epoch.",
    409,
  );
  assert(
    old.action === r.action && old.fingerprint === r.fingerprint,
    "IDEMPOTENCY_CONFLICT",
    "This request ID was already used with a different body.",
    409,
  );
  if (r.actor.kind === "key")
    assert(
      r.actor.status === "active" || (r.actor.status === "soft_revoked" && r.action === "report"),
      "KEY_REVOKED",
      "This key cannot replay this operation.",
      403,
    );
}
async function authorizeReplay(r: Receipt, old: Row) {
  // Evaluate present authorization and the database epoch in one snapshot, including
  // duplicate-insertion races. A receipt never restores revoked authority.
  const current = await one(
    r.env.DB,
    `SELECT active_epoch,
    (SELECT status FROM api_keys WHERE id=?) key_status,
    EXISTS(SELECT 1 FROM administrators WHERE subject=? AND active=1) administrator_active,
    (SELECT min(a.expires_at)>${DB_NOW} FROM request_items i JOIN attempts a ON a.id=i.attempt_id AND a.issuing_key_id=? WHERE i.request_uid=?) report_live
    FROM installation WHERE id=1`,
    r.actor.id,
    r.actor.id,
    r.actor.id,
    old.uid,
  );
  assert(
    current?.active_epoch === r.env.INSTANCE_EPOCH,
    "INSTANCE_CHANGED",
    "The installation epoch has changed.",
    409,
  );
  if (r.actor.kind === "key") {
    r.actor.status = current.key_status;
    assert(
      current.key_status === "active" ||
        (current.key_status === "soft_revoked" &&
          r.action === "report" &&
          current.report_live === 1),
      "KEY_REVOKED",
      "This key no longer has permission to replay the request.",
      403,
    );
  } else
    assert(
      r.actor.owner || current.administrator_active === 1,
      "FORBIDDEN",
      "Administrator access was removed.",
      403,
    );
  checkReplay(r, old);
}
export function configGuard(r: Receipt, checks: { table: string; id: string; revision: number }[]) {
  const clauses = checks.map(
    (c) =>
      `EXISTS(SELECT 1 FROM ${c.table} WHERE ${c.table === "installation" ? "id" : "id"}=? AND config_revision=?)`,
  );
  r.statements.push(
    stmt(
      r.env.DB,
      `UPDATE requests SET guard_config=(${clauses.join(" AND ") || "1"}) WHERE uid=?`,
      ...checks.flatMap((c) => [c.id, c.revision]),
      r.uid,
    ),
  );
}
export function audit(
  r: Receipt,
  entityType: string,
  entityId: string | null,
  diff: unknown,
  reason?: string,
) {
  r.statements.push(
    stmt(
      r.env.DB,
      "INSERT INTO audit_events(id,actor,email,operation_id,entity_type,entity_id,timestamp,reason,diff_json) SELECT ?,?,?,?,?,?,accepted_at,?,? FROM requests WHERE uid=?",
      crypto.randomUUID(),
      actorId(r.actor),
      r.actor.kind === "admin" ? r.actor.email : null,
      r.body.request_id,
      entityType,
      entityId,
      reason ?? null,
      json(diff),
      r.uid,
    ),
  );
}
export async function commitReceipt(
  r: Receipt,
  metadata?: unknown,
): Promise<{ receipt: Row; items: Row[]; replayed: boolean }> {
  const db = r.env.DB;
  if (r.existing) await authorizeReplay(r, r.existing);
  if (r.existing)
    return {
      receipt: r.existing,
      items: await all(
        db,
        "SELECT * FROM request_items WHERE request_uid=? ORDER BY ordinal",
        r.existing.uid,
      ),
      replayed: true,
    };
  if (metadata !== undefined)
    r.statements.push(
      stmt(db, "UPDATE requests SET metadata_json=? WHERE uid=?", json(metadata), r.uid),
    );
  r.statements.push(stmt(db, "UPDATE requests SET complete=1 WHERE uid=?", r.uid));
  r.statements.push(
    stmt(db, "SELECT * FROM requests WHERE uid=?", r.uid),
    stmt(db, "SELECT * FROM request_items WHERE request_uid=? ORDER BY ordinal", r.uid),
  );
  assert(
    r.statements.length <= 40,
    "INTERNAL_ERROR",
    "Atomic operation exceeds the query budget.",
    500,
  );
  try {
    const results = await db.batch<Row>(r.statements);
    return {
      receipt: results.at(-2)!.results[0],
      items: results.at(-1)!.results,
      replayed: false,
    };
  } catch (error) {
    const prior = await one(
      db,
      "SELECT * FROM requests WHERE actor=? AND request_id=?",
      actorId(r.actor),
      r.body.request_id,
    );
    if (prior) {
      await authorizeReplay(r, prior);
      return {
        receipt: prior,
        items: await all(
          db,
          "SELECT * FROM request_items WHERE request_uid=? ORDER BY ordinal",
          prior.uid,
        ),
        replayed: true,
      };
    }
    const message = String(error);
    for (const code of [
      "INSTANCE_CHANGED",
      "CONFIG_CHANGED",
      "FORBIDDEN",
      "MAINTENANCE",
      "REQUEST_TOO_OLD",
    ])
      if (message.includes(code))
        throw new AppError(
          code,
          code === "CONFIG_CHANGED"
            ? "Configuration changed; refresh and retry the same operation."
            : code === "MAINTENANCE"
              ? "The installation is closed for maintenance."
              : `Operation rejected: ${code.toLowerCase().replaceAll("_", " ")}.`,
          code === "FORBIDDEN" ? 403 : code === "REQUEST_TOO_OLD" ? 410 : 409,
        );
    if (/UNIQUE constraint failed: task_identifiers|UNIQUE constraint failed: tasks/.test(message))
      throw new AppError(
        "EDIT_CONFLICT",
        "This task ID already exists or is reserved by history.",
        409,
      );
    const resource = resourceError(error);
    if (resource) throw resource;
    console.error(
      json({
        event: "database_failure",
        request_id: r.body.request_id,
        error_class: "unexpected_database_error",
      }),
    );
    throw new AppError(
      "INTERNAL_ERROR",
      "The database transition failed and was rolled back.",
      500,
    );
  }
}
