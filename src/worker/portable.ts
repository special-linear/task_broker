import { physicalIndexName } from "./sort-indexes";
import { recordDto, importedRecord } from "./presentation";
import { z } from "zod";
import { assert, json, policySchema, validate, VERSION } from "../shared/core";
import { mutation } from "../shared/contracts";
import { actorId, all, audit, beginReceipt, commitReceipt, DB_NOW, one, stmt } from "./db";
import type { Context, Row } from "./types";
const TABLES = [
  "families",
  "pools",
  "pool_fields",
  "claim_sort_indexes",
  "schema_versions",
  "profiles",
  "profile_aliases",
  "tasks",
  "legacy_imports",
  "task_identifiers",
  "task_tags",
  "task_profile_state",
  "input_snapshots",
  "attempts",
  "attempt_results",
  "attempt_events",
  "saved_views",
  "audit_events",
];
const OMIT: Record<string, string[]> = {
  attempts: ["lease_token"],
  saved_views: ["owner"],
};
export async function portableManifest(c: Context) {
  const install = (await one(c.env.DB, "SELECT * FROM installation WHERE id=1"))!;
  const migrations = await all(
    c.env.DB,
    "SELECT id,name FROM pools WHERE migration_status!='ready' LIMIT 100",
  );
  return {
    pending_schema_migrations: migrations,
    format: "task-broker-portable",
    format_version: 1,
    app_version: VERSION,
    schema_version: install.schema_version,
    created_at: new Date().toISOString(),
    consistent: !!install.maintenance,
    traversal: install.maintenance
      ? "Business data is stable under maintenance."
      : "Live traversal; values and membership may change.",
    tables: TABLES,
    defaults: JSON.parse(install.defaults_json),
    omitted: [
      "API-key secrets and digests",
      "lease tokens",
      "live lease heads",
      "request receipts",
      "administrator identities",
      "installation epoch",
      "personal view ownership",
    ],
  };
}
export async function portablePage(c: Context) {
  const table = c.url.searchParams.get("table") ?? "";
  assert(TABLES.includes(table), "INVALID_VALUE", "Unsupported export record type.");
  const after = Number(c.url.searchParams.get("after") || 0);
  assert(Number.isSafeInteger(after) && after >= 0, "INVALID_VALUE", "Invalid export position.");
  const rows = await all(
    c.env.DB,
    `SELECT rowid __cursor,* FROM ${table} WHERE rowid>? ${table === "saved_views" ? "AND shared=1" : ""} ORDER BY rowid LIMIT 100`,
    after,
  );
  const last = rows.at(-1)?.__cursor;
  return {
    rows: rows.map((r) =>
      Object.fromEntries(
        Object.entries(recordDto(r)).filter(
          ([k]) => k !== "__cursor" && !(OMIT[table] ?? []).includes(k),
        ),
      ),
    ),
    next: rows.length === 100 ? String(last) : null,
  };
}
export async function portableImportPreview(c: Context) {
  assert(
    c.actor.kind === "admin" && c.actor.owner,
    "FORBIDDEN",
    "A deployment owner must approve installation import.",
    403,
  );
  const body = validate(
      mutation
        .extend({
          manifest: z
            .object({
              format: z.literal("task-broker-portable"),
              format_version: z.literal(1),
              schema_version: z.number().int().min(1).max(5),
            })
            .passthrough(),
          total_records: z.number().int().nonnegative(),
        })
        .strict(),
      c.body,
    ),
    r = await beginReceipt(c.env, c.actor, "portable.preview", "installation", body, {
      maintenance: true,
    }),
    id = crypto.randomUUID();
  assert(
    !body.manifest.pending_schema_migrations ||
      (Array.isArray(body.manifest.pending_schema_migrations) &&
        body.manifest.pending_schema_migrations.length === 0),
    "INVALID_VALUE",
    "Finish source schema migrations before creating a portable installation export. Native backups preserve unfinished operations.",
  );
  if (!r.existing) {
    const defaults = validate(policySchema, body.manifest.defaults ?? {});
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE requests SET guard_maintenance=(SELECT maintenance=1 FROM installation WHERE id=1),guard_config=NOT EXISTS(SELECT 1 FROM pools) WHERE uid=?",
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO admin_operations(id,actor,kind,action_json,total,created_at,expires_at) VALUES(?,?,'portable',?,?,${DB_NOW},${DB_NOW}+86400000)`,
        id,
        actorId(c.actor),
        json(body.manifest),
        body.total_records,
      ),
    );
    audit(r, "portable_import", id, {
      approved: true,
      total: body.total_records,
    });
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE installation SET defaults_json=?,config_revision=config_revision+1,receipt_retention_ms=max(receipt_retention_ms,?) WHERE id=1",
        json(defaults),
        ((defaults.max_lifetime_seconds ?? 86400) + 86400) * 1000,
      ),
    );
  }
  return JSON.parse(
    (await commitReceipt(r, { operation_id: id, disabled_on_import: true })).receipt.metadata_json,
  );
}
export async function portableImportChunk(c: Context, id: string) {
  assert(
    c.actor.kind === "admin" && c.actor.owner,
    "FORBIDDEN",
    "A deployment owner is required.",
    403,
  );
  const body = validate(
      mutation
        .extend({
          table: z.enum(TABLES as [string, ...string[]]),
          rows: z.array(z.record(z.string(), z.unknown())).max(100),
        })
        .strict(),
      c.body,
    ),
    op = await one(
      c.env.DB,
      "SELECT * FROM admin_operations WHERE id=? AND actor=? AND kind='portable'",
      id,
      actorId(c.actor),
    );
  assert(op, "NOT_FOUND", "Portable import not found.", 404);
  const r = await beginReceipt(c.env, c.actor, "portable.chunk", id, body, {
    maintenance: true,
  });
  if (!r.existing) {
    assert(
      op.status !== "cancelled" && op.status !== "complete",
      "EDIT_CONFLICT",
      "This portable import is closed.",
      409,
    );
    assert(
      op.processed + body.rows.length <= op.total,
      "INVALID_VALUE",
      "The chunk exceeds the declared record count.",
    );
    const tableIndex = TABLES.indexOf(body.table),
      lastTable = JSON.parse(op.summary_json).last_table_index ?? -1;
    assert(
      tableIndex >= lastTable,
      "INVALID_VALUE",
      "Portable records must follow the manifest table order.",
    );
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE requests SET guard_maintenance=(SELECT maintenance=1 FROM installation WHERE id=1),guard_config=EXISTS(SELECT 1 FROM admin_operations WHERE id=? AND processed=? AND status IN('preview','applying')) WHERE uid=?",
        id,
        op.processed,
        r.uid,
      ),
    );
    const columns = (await all(c.env.DB, `PRAGMA table_info(${body.table})`)).map(
      (c) => c.name as string,
    );
    const rows = body.rows.map((source) => {
      const row = importedRecord(source);
      for (const key of Object.keys(row))
        assert(columns.includes(key), "INVALID_VALUE", `Unknown imported field ${key}.`);
      if (["families", "profiles", "pools"].includes(body.table)) row.enabled = 0;
      if (body.table === "pools") row.migration_status = "ready";
      if (body.table === "claim_sort_indexes") {
        row.status = "unbuilt";
        row.built_at = null;
        row.index_name = physicalIndexName(row.id);
      }
      if (body.table === "tasks") {
        row.latest_attempt_id = null;
        row.lease_generation = Number(row.lease_generation) + 1;
      }
      if (body.table === "attempts") {
        row.lease_token = "";
        row.instance_epoch = "imported";
        if (row.outcome === null) {
          row.revoked_at = Date.now();
          row.revoke_reason = "portable import";
        }
      }
      if (body.table === "saved_views") {
        row.shared = 1;
        row.owner = c.actor.id;
      }
      return row;
    });
    if (body.table === "attempts") {
      const keys = [
        ...new Map(
          rows.map((r) => [
            String(r.issuing_key_id),
            { id: r.issuing_key_id, family_id: r.family_id },
          ]),
        ).values(),
      ];
      r.statements.push(
        stmt(
          c.env.DB,
          `INSERT INTO api_keys(id,family_id,label,prefix,secret_digest,status,issued_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.family_id'),'Imported historical key','imported',?,'hard_revoked',${DB_NOW} FROM json_each(?) WHERE 1 ON CONFLICT(id) DO NOTHING`,
          "0".repeat(64),
          json(keys),
        ),
      );
    }
    const used = columns.filter((k) => rows.some((r) => Object.hasOwn(r, k)));
    if (rows.length)
      r.statements.push(
        stmt(
          c.env.DB,
          `INSERT INTO ${body.table}(${used.map((k) => `"${k}"`).join(",")}) SELECT ${used.map((k) => `json_extract(value,'$.${k}')`).join(",")} FROM json_each(?)`,
          json(rows),
        ),
      );
    if (body.table === "claim_sort_indexes")
      r.statements.push(
        stmt(
          c.env.DB,
          "UPDATE requests SET guard_config=NOT EXISTS(SELECT 1 FROM claim_sort_indexes GROUP BY pool_id HAVING count(*)>4) WHERE uid=?",
          r.uid,
        ),
      );
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE admin_operations SET processed=processed+?,status=CASE WHEN processed+?>=total THEN 'complete' ELSE 'applying' END,summary_json=json_object('last_table_index',?) WHERE id=?",
        rows.length,
        rows.length,
        tableIndex,
        id,
      ),
    );
  }
  return JSON.parse(
    (
      await commitReceipt(r, {
        imported: body.rows.length,
        table: body.table,
        operation_id: id,
      })
    ).receipt.metadata_json,
  );
}
export async function prune(c: Context) {
  const body = validate(mutation.strict(), c.body),
    r = await beginReceipt(c.env, c.actor, "maintenance.prune", "installation", body);
  if (!r.existing) {
    r.statements.push(
      stmt(
        c.env.DB,
        `DELETE FROM requests WHERE uid IN(SELECT uid FROM requests WHERE retention_deadline<${DB_NOW} ORDER BY retention_deadline LIMIT 100)`,
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        `DELETE FROM admin_operation_items WHERE rowid IN(SELECT i.rowid FROM admin_operation_items i JOIN admin_operations o ON o.id=i.operation_id WHERE o.expires_at<${DB_NOW} AND o.kind IN('export','import','bulk') ORDER BY o.expires_at LIMIT 100)`,
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        `DELETE FROM admin_operations WHERE id IN(SELECT id FROM admin_operations WHERE expires_at<${DB_NOW} AND kind IN('export','import','bulk') AND NOT EXISTS(SELECT 1 FROM admin_operation_items WHERE operation_id=admin_operations.id) LIMIT 100)`,
      ),
    );
    audit(r, "maintenance", "prune", { bounded_cleanup: true });
  }
  return JSON.parse(
    (await commitReceipt(r, { pruned: true, permanent_history_retained: true })).receipt
      .metadata_json,
  );
}
