import { sortSchema, resolveSorts, sortOrder, sortSpec, defaultSorts } from "../shared/sort";
import { sortResolver } from "./sorting";
import { z } from "zod";
import {
  AppError,
  assert,
  canonical,
  iso,
  json,
  idSchema,
  mapResult,
  normalizeInput,
  normalizeTags,
  sha256,
  validate,
} from "../shared/core";
import { mutation, patchSchema } from "../shared/contracts";
import { compileFilter, parseFilter, sqlString } from "../shared/filter";
import {
  actorId,
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
import { fieldsFor, resolverFor, taskDto } from "./model";
import { historyDto, stageTaskChanges, type EditItem } from "./tasks";
import type { Context, Row } from "./types";
const selectionSchema = z
  .object({
    ids: z.array(z.string()).max(10000).optional(),
    filter: z.string().default(""),
    include_deleted: z.boolean().default(false),
  })
  .strict();
const actionSchema = z
  .object({
    kind: z.enum([
      "enable",
      "disable",
      "set_tags",
      "edit",
      "duplicate",
      "delete",
      "restore",
      "revoke",
      "reset",
      "revoke_edit",
      "reset_edit",
    ]),
    patch: patchSchema.optional(),
    mode: z.enum(["soft", "full"]).default("soft"),
    scope: z.enum(["profile", "all"]).default("all"),
    revoke: z.boolean().default(false),
    reason: z.string().default(""),
  })
  .strict();
const previewSchema = mutation
  .extend({
    pool_id: z.string().uuid(),
    profile_id: z.string().uuid().optional(),
    selection: selectionSchema,
    action: actionSchema,
  })
  .strict();
export async function operationPreview(c: Context, exporting = false) {
  const body = exporting
    ? validate(
        mutation
          .extend({
            pool_id: z.string().uuid(),
            profile_id: z.string().uuid().optional(),
            selection: selectionSchema,
            history: z.boolean().default(false),
            sorts: sortSchema.optional(),
          })
          .strict(),
        c.body,
      )
    : validate(previewSchema, c.body);
  const r = await beginReceipt(
      c.env,
      c.actor,
      exporting ? "export.create" : "operation.preview",
      body.pool_id,
      body,
      { maintenance: exporting },
    ),
    id = crypto.randomUUID();
  if (!r.existing) {
    const exportPool = exporting
      ? await one(c.env.DB, "SELECT * FROM pools WHERE id=?", body.pool_id)
      : null;
    if (exporting) {
      assert(exportPool, "NOT_FOUND", "Pool not found.", 404);
      configGuard(r, [{ table: "pools", id: body.pool_id, revision: exportPool.config_revision }]);
    }
    const fields = await fieldsFor(c.env, body.pool_id),
      profileId = body.profile_id ?? null;
    if (profileId)
      assert(
        await one(
          c.env.DB,
          "SELECT id FROM profiles WHERE id=? AND pool_id=?",
          profileId,
          body.pool_id,
        ),
        "INVALID_VALUE",
        "Profile does not belong to this pool.",
      );
    if (!exporting && (body as any).action.scope === "profile")
      assert(profileId, "INVALID_VALUE", "Profile-scoped reset requires a profile.");
    const filter = compileFilter(
      parseFilter(body.selection.filter),
      resolverFor(fields, profileId),
    );
    const joins = profileId
      ? `JOIN profiles p ON p.id=${sqlString(profileId)} JOIN families f ON f.id=p.family_id LEFT JOIN task_profile_state ps ON ps.task_uid=t.task_uid AND ps.profile_id=p.id`
      : "";
    const exportSorts = exporting
      ? resolveSorts((body as any).sorts ?? defaultSorts(), sortResolver(fields, profileId))
      : [];
    const exportOrder = exporting ? sortOrder(exportSorts) : "t.task_id COLLATE BINARY,t.task_uid";
    const ids = body.selection.ids
      ? `AND t.task_uid IN(SELECT value FROM json_each(?${filter.params.length + 1}))`
      : "";
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO admin_operations(id,actor,kind,pool_id,profile_id,action_json,selection_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,${DB_NOW},${DB_NOW}+86400000)`,
        id,
        actorId(c.actor),
        exporting ? "export" : "bulk",
        body.pool_id,
        profileId,
        json(
          exporting
            ? { history: (body as any).history, sorts: sortSpec(exportSorts) }
            : (body as any).action,
        ),
        json(body.selection),
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO admin_operation_items(operation_id,ordinal,task_uid,expected_edit_revision,expected_input_revision,expected_state_revision,expected_generation) SELECT ${sqlString(id)},row_number() OVER(ORDER BY ${exportOrder})-1,t.task_uid,t.edit_revision,t.input_revision,t.state_revision,t.lease_generation FROM tasks t JOIN pools po ON po.id=t.pool_id ${joins} WHERE t.pool_id=${sqlString(body.pool_id)} ${body.selection.include_deleted ? "" : "AND t.deleted_at IS NULL"} ${ids} AND (${filter.sql})`,
        ...filter.params,
        ...(body.selection.ids ? [json(body.selection.ids)] : []),
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE admin_operations SET total=(SELECT COUNT(*) FROM admin_operation_items WHERE operation_id=?) WHERE id=?",
        id,
        id,
      ),
    );
    if (!exporting)
      audit(r, "operation", id, {
        selection: body.selection,
        action: (body as any).action ?? "export",
      });
  }
  return JSON.parse((await commitReceipt(r, { operation_id: id })).receipt.metadata_json);
}
export async function patchPreview(c: Context) {
  const body = validate(
    mutation
      .extend({
        pool_id: z.string().uuid(),
        rows: z
          .array(
            z
              .object({
                task_uid: z.string().uuid(),
                expected_edit_revision: z.number().int().positive(),
                patch: patchSchema,
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    c.body,
  );
  assert(
    new Set(body.rows.map((r) => r.task_uid)).size === body.rows.length,
    "INVALID_VALUE",
    "Each task may appear only once in a patch preview.",
  );
  const r = await beginReceipt(c.env, c.actor, "patches.preview", body.pool_id, body),
    id = crypto.randomUUID();
  if (!r.existing) {
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO admin_operations(id,actor,kind,pool_id,action_json,selection_json,created_at,expires_at,total) VALUES(?,?,'bulk',?,'{"kind":"edit","patch":{}}',?,${DB_NOW},${DB_NOW}+86400000,?)`,
        id,
        actorId(c.actor),
        body.pool_id,
        json({ ids: body.rows.map((x) => x.task_uid) }),
        body.rows.length,
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO admin_operation_items(operation_id,ordinal,task_uid,expected_edit_revision,expected_input_revision,expected_state_revision,expected_generation,payload_json,status,outcome_json) SELECT ?,CAST(j.key AS INTEGER),json_extract(j.value,'$.task_uid'),json_extract(j.value,'$.expected_edit_revision'),t.input_revision,t.state_revision,t.lease_generation,json_object('patch',json_extract(j.value,'$.patch')),CASE WHEN t.task_uid IS NULL OR t.pool_id!=? OR t.edit_revision!=json_extract(j.value,'$.expected_edit_revision') THEN 'rejected' ELSE 'pending' END,CASE WHEN t.task_uid IS NULL OR t.pool_id!=? OR t.edit_revision!=json_extract(j.value,'$.expected_edit_revision') THEN '{"error":"EDIT_CONFLICT"}' END FROM json_each(?) j LEFT JOIN tasks t ON t.task_uid=json_extract(j.value,'$.task_uid')`,
        id,
        body.pool_id,
        body.pool_id,
        json(body.rows),
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE admin_operations SET processed=(SELECT COUNT(*) FROM admin_operation_items WHERE operation_id=? AND status='rejected') WHERE id=?",
        id,
        id,
      ),
    );
    audit(r, "operation", id, { kind: "patches", task_ids: body.rows.map((x) => x.task_uid) });
  }
  return JSON.parse((await commitReceipt(r, { operation_id: id })).receipt.metadata_json);
}
export async function getOperation(c: Context, id: string) {
  const op = await one(
    c.env.DB,
    "SELECT * FROM admin_operations WHERE id=? AND actor=?",
    id,
    actorId(c.actor),
  );
  assert(op, "NOT_FOUND", "Operation not found.", 404);
  return op;
}
export async function operationStatus(c: Context, id: string) {
  const op = await getOperation(c, id),
    offset = Math.max(0, Number(c.url.searchParams.get("offset") ?? 0));
  const counts = await all(
    c.env.DB,
    "SELECT status,COUNT(*) count FROM admin_operation_items WHERE operation_id=? GROUP BY status",
    id,
  );
  const items = await all(
    c.env.DB,
    "SELECT i.ordinal,i.task_uid,t.task_id,i.status,i.outcome_json,i.expected_edit_revision,i.expected_generation,h.profile_id issuing_profile_id,h.worker_id,h.expires_at FROM admin_operation_items i LEFT JOIN tasks t ON t.task_uid=i.task_uid LEFT JOIN lease_heads h ON h.task_uid=i.task_uid WHERE i.operation_id=? ORDER BY i.ordinal LIMIT 100 OFFSET ?",
    id,
    offset,
  );
  return {
    ...op,
    created_at: iso(op.created_at),
    expires_at: iso(op.expires_at),
    action: JSON.parse(op.action_json),
    selection: JSON.parse(op.selection_json),
    counts,
    items: items.map((i) => ({
      ...i,
      expires_at: iso(i.expires_at),
      outcome: i.outcome_json ? JSON.parse(i.outcome_json) : null,
      outcome_json: undefined,
    })),
    expired: op.expires_at < Date.now(),
  };
}
export async function operationControl(c: Context, id: string, action: "cancel" | "refresh") {
  const body = validate(mutation.strict(), c.body),
    op = await getOperation(c, id),
    r = await beginReceipt(c.env, c.actor, `operation.${action}`, id, body);
  if (!r.existing) {
    assert(
      op.kind !== "schema" || action === "refresh" || op.status === "preview",
      "INVALID_VALUE",
      "Schema migrations must finish before the pool can reopen.",
    );
    r.statements.push(
      stmt(
        c.env.DB,
        action === "cancel"
          ? "UPDATE admin_operations SET status='cancelled' WHERE id=?"
          : `UPDATE admin_operations SET expires_at=${DB_NOW}+86400000 WHERE id=?`,
        id,
      ),
    );
    audit(r, "operation", id, { action });
  }
  return JSON.parse(
    (
      await commitReceipt(r, {
        operation_id: id,
        status: action === "cancel" ? "cancelled" : op.status,
      })
    ).receipt.metadata_json,
  );
}
export async function importPreview(c: Context) {
  const body = validate(
      mutation
        .extend({
          pool_id: z.string().uuid(),
          mode: z.enum(["add", "update", "upsert", "legacy"]),
          total: z.number().int().min(0).max(10000),
          mapping: z.record(z.string(), z.string()).default({}),
        })
        .strict(),
      c.body,
    ),
    r = await beginReceipt(c.env, c.actor, "import.preview", body.pool_id, body),
    id = crypto.randomUUID();
  if (!r.existing) {
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO admin_operations(id,actor,kind,pool_id,action_json,selection_json,created_at,expires_at,total) VALUES(?,?,'import',?,?,?,${DB_NOW},${DB_NOW}+86400000,?)`,
        id,
        actorId(c.actor),
        body.pool_id,
        json({ mode: body.mode }),
        json({ mapping: body.mapping }),
        body.total,
      ),
    );
    audit(r, "import", id, { mode: body.mode, total: body.total });
  }
  return JSON.parse((await commitReceipt(r, { operation_id: id })).receipt.metadata_json);
}
export async function importPreviewChunk(c: Context, id: string) {
  const body = validate(
    mutation
      .extend({
        start: z.number().int().nonnegative(),
        rows: z
          .array(
            z
              .object({
                task_id: z.string().optional(),
                data: z.record(z.string(), z.unknown()),
                tags: z.array(z.string()).optional(),
                enabled: z.boolean().optional(),
                legacy_result: z.unknown().optional(),
                legacy_attempts: z.number().int().nonnegative().optional(),
                legacy_completed: z.boolean().optional(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
    c.body,
  );
  const op = await getOperation(c, id),
    r = await beginReceipt(c.env, c.actor, "import.preview_chunk", id, body);
  assert(op.kind === "import", "INVALID_VALUE", "This is not an import operation.");
  if (!r.existing) {
    assert(
      op.status === "preview" && op.expires_at > Date.now(),
      "EDIT_CONFLICT",
      "Import preview is closed or expired.",
      409,
    );
    assert(
      body.start + body.rows.length <= op.total,
      "INVALID_VALUE",
      "Preview chunk exceeds the declared row count.",
    );
    const fields = await fieldsFor(c.env, op.pool_id),
      mode = JSON.parse(op.action_json).mode;
    const old = await all(
      c.env.DB,
      "SELECT t.*,ti.public_id FROM task_identifiers ti JOIN tasks t ON t.task_uid=ti.task_uid WHERE ti.pool_id=? AND ti.public_id IN(SELECT value FROM json_each(?))",
      op.pool_id,
      json(body.rows.map((x) => x.task_id).filter(Boolean)),
    );
    const prepared: Row[] = [];
    for (let ix = 0; ix < body.rows.length; ix++) {
      const raw = body.rows[ix],
        previous = old.find((t) => t.public_id === raw.task_id),
        taskId = raw.task_id ?? crypto.randomUUID();
      let error: string | null = null;
      const duplicate =
        raw.task_id && body.rows.filter((x) => x.task_id === raw.task_id).length > 1;
      if (duplicate) error = "Duplicate task ID in this chunk.";
      else if (
        previous &&
        (mode === "add" ||
          mode === "legacy" ||
          previous.deleted_at !== null ||
          previous.public_id !== previous.task_id)
      )
        error = "Existing or tombstoned task ID.";
      else if (!previous && mode === "update") error = "No existing task with this ID.";
      try {
        validate(idSchema, taskId);
        normalizeInput(
          previous ? { ...JSON.parse(previous.parameters_json), ...raw.data } : raw.data,
          fields,
          !previous,
        );
        if (raw.tags) normalizeTags(raw.tags);
        if (mode === "legacy" && Object.hasOwn(raw, "legacy_result"))
          mapResult(raw.legacy_result, fields, false);
        if (mode === "legacy" && raw.legacy_completed && !Object.hasOwn(raw, "legacy_result"))
          throw new Error("Completed legacy rows require an explicitly mapped result.");
      } catch (e) {
        error = e instanceof Error ? e.message : "Invalid input.";
      }
      if (
        mode !== "legacy" &&
        (raw.legacy_result !== undefined ||
          raw.legacy_attempts !== undefined ||
          raw.legacy_completed !== undefined)
      )
        error = "Runtime state can only be supplied in reviewed legacy migration mode.";
      prepared.push({
        ordinal: body.start + ix,
        task_uid: previous?.task_uid ?? crypto.randomUUID(),
        expected_edit_revision: previous?.edit_revision ?? null,
        expected_input_revision: previous?.input_revision ?? null,
        expected_state_revision: previous?.state_revision ?? null,
        expected_generation: previous?.lease_generation ?? null,
        payload: { ...raw, task_id: taskId, create: !previous },
        error,
      });
    }
    r.statements.push(
      stmt(
        c.env.DB,
        `UPDATE requests SET guard_config=EXISTS(SELECT 1 FROM admin_operations WHERE id=? AND status='preview' AND expires_at>${DB_NOW}) WHERE uid=?`,
        id,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO admin_operation_items(operation_id,ordinal,task_uid,expected_edit_revision,expected_input_revision,expected_state_revision,expected_generation,payload_json,status,outcome_json) SELECT ?,json_extract(value,'$.ordinal'),json_extract(value,'$.task_uid'),json_extract(value,'$.expected_edit_revision'),json_extract(value,'$.expected_input_revision'),json_extract(value,'$.expected_state_revision'),json_extract(value,'$.expected_generation'),json_extract(value,'$.payload'),CASE WHEN json_extract(value,'$.error') IS NULL THEN 'pending' ELSE 'rejected' END,CASE WHEN json_extract(value,'$.error') IS NULL THEN NULL ELSE json_object('error',json_extract(value,'$.error')) END FROM json_each(?)`,
        id,
        json(prepared),
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE admin_operations SET processed=processed+? WHERE id=?",
        prepared.filter((row) => row.error !== null).length,
        id,
      ),
    );
  }
  return JSON.parse(
    (await commitReceipt(r, { operation_id: id, staged: body.rows.length })).receipt.metadata_json,
  );
}
export async function applyOperation(c: Context, id: string) {
  const body = validate(
      mutation
        .extend({
          start: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .strict(),
      c.body,
    ),
    op = await getOperation(c, id),
    r = await beginReceipt(c.env, c.actor, "operation.apply", id, body);
  assert(
    ["bulk", "import"].includes(op.kind),
    "INVALID_VALUE",
    "This operation cannot be applied here.",
  );
  if (!r.existing && op.status === "complete") {
    await commitReceipt(r);
    return { operation_id: id, items: [], replayed: false };
  }
  if (!r.existing) {
    assert(
      op.status !== "cancelled" && op.expires_at > Date.now(),
      "EDIT_CONFLICT",
      "Operation is cancelled or expired.",
      409,
    );
    const action = JSON.parse(op.action_json),
      items = await all(
        c.env.DB,
        `SELECT * FROM admin_operation_items WHERE operation_id=? AND status='pending' ${body.start === undefined ? "" : "AND ordinal>=?"} ORDER BY ordinal LIMIT ?`,
        id,
        ...(body.start === undefined ? [] : [body.start]),
        body.limit,
      );
    const current = await all(
        c.env.DB,
        "SELECT * FROM tasks WHERE task_uid IN(SELECT value FROM json_each(?))",
        json(items.map((i) => i.task_uid)),
      ),
      fields = await fieldsFor(c.env, op.pool_id),
      pool = (await one(c.env.DB, "SELECT * FROM pools WHERE id=?", op.pool_id))!;
    configGuard(r, [{ table: "pools", id: pool.id, revision: pool.config_revision }]);
    if (action.mode === "legacy")
      r.statements.push(
        stmt(
          c.env.DB,
          "UPDATE requests SET guard_config=(SELECT enabled=0 AND migration_status='ready' FROM pools WHERE id=?) WHERE uid=?",
          pool.id,
          r.uid,
        ),
      );
    r.statements.push(
      stmt(
        c.env.DB,
        `UPDATE requests SET guard_config=EXISTS(SELECT 1 FROM admin_operations WHERE id=? AND status IN('preview','applying') AND expires_at>${DB_NOW}) WHERE uid=?`,
        id,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE requests SET guard_config=NOT EXISTS(SELECT 1 FROM admin_operation_items WHERE operation_id=? AND ordinal IN(SELECT value FROM json_each(?)) AND status!='pending') WHERE uid=?",
        id,
        json(items.map((i) => i.ordinal)),
        r.uid,
      ),
    );
    const edits: EditItem[] = [],
      creates: Row[] = [];
    for (const i of items) {
      const t = current.find((t) => t.task_uid === i.task_uid),
        payload = i.payload_json ? JSON.parse(i.payload_json) : null;
      if (op.kind === "import" && payload.create) {
        let error: string | null = null,
          data: unknown = {},
          legacy: Row | null = null,
          tags: string[] = [];
        try {
          data = normalizeInput(payload.data, fields, true);
          tags = normalizeTags(payload.tags ?? []);
          if (action.mode === "legacy")
            legacy = {
              ...payload,
              mapped: Object.hasOwn(payload, "legacy_result")
                ? mapResult(payload.legacy_result, fields, !!pool.required_result)
                : null,
            };
        } catch (e) {
          error = e instanceof Error ? e.message : "Invalid input.";
        }
        creates.push({
          ordinal: i.ordinal,
          task_uid: i.task_uid,
          task_id: payload.task_id,
          data,
          tags,
          hash: await sha256(canonical({ data, tags })),
          enabled: payload.enabled ?? true,
          error,
          legacy,
        });
        continue;
      }
      if (action.kind === "duplicate" && t) {
        const data = JSON.parse(t.parameters_json),
          tags = JSON.parse(t.tags_json);
        creates.push({
          ordinal: i.ordinal,
          task_uid: crypto.randomUUID(),
          task_id: crypto.randomUUID(),
          data,
          tags,
          hash: t.input_hash,
          enabled: !!t.enabled,
          error: null,
          source_uid: t.task_uid,
          source_revision: i.expected_edit_revision,
        });
        continue;
      }
      const patch =
        op.kind === "import"
          ? {
              data: payload.data,
              ...(payload.tags ? { tags: payload.tags } : {}),
              ...(payload.enabled === undefined ? {} : { enabled: payload.enabled }),
            }
          : action.kind === "enable"
            ? { enabled: true }
            : action.kind === "disable"
              ? { enabled: false }
              : (payload?.patch ?? action.patch ?? {});
      edits.push({
        task: t ?? {
          task_uid: i.task_uid,
          parameters_json: "{}",
          tags_json: "[]",
          input_hash: "",
          input_revision: 0,
        },
        expected_edit_revision: i.expected_edit_revision,
        expected_input_revision: i.expected_input_revision,
        expected_state_revision: i.expected_state_revision,
        expected_generation: i.expected_generation,
        ordinal: i.ordinal,
        patch,
        kind: op.kind === "import" ? "edit" : action.kind,
        scope: action.scope,
        mode: action.mode,
        profile_id: op.profile_id,
        revoke: action.revoke,
        error: t ? undefined : "NOT_FOUND",
      });
    }
    if (edits.length) await stageTaskChanges(r, edits, fields);
    if (creates.length) await stageCreates(r, creates, pool);
    if (action.mode === "legacy") {
      r.statements.push(
        stmt(
          c.env.DB,
          `INSERT INTO legacy_imports(task_uid,operation_id,imported_at,source_json,raw_result_json,historical_attempts,imported_completed) SELECT task_uid,?,q.accepted_at,json_extract(i.value_json,'$.legacy'),i.value_json->'$.legacy.legacy_result',COALESCE(json_extract(i.value_json,'$.legacy.legacy_attempts'),0),COALESCE(json_extract(i.value_json,'$.legacy.legacy_completed'),0) FROM request_items i JOIN requests q ON q.uid=i.request_uid WHERE i.request_uid=? AND i.status='applied'`,
          op.id,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          c.env.DB,
          `UPDATE tasks SET attempts_total=li.historical_attempts,lifetime_attempts=li.historical_attempts,completed_at=CASE WHEN li.imported_completed=1 THEN li.imported_at END,result_summary_json=json_extract(i.value_json,'$.legacy.mapped') FROM legacy_imports li JOIN request_items i ON i.task_uid=li.task_uid WHERE tasks.task_uid=li.task_uid AND i.request_uid=? AND i.status='applied'`,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          c.env.DB,
          `INSERT INTO task_profile_state(task_uid,profile_id,attempts,lifetime_attempts) SELECT li.task_uid,p.id,li.historical_attempts,li.historical_attempts FROM legacy_imports li JOIN tasks t ON t.task_uid=li.task_uid JOIN families f ON f.id=? JOIN profiles p ON p.id=f.default_profile_id AND p.pool_id=t.pool_id WHERE li.operation_id=? AND li.task_uid IN(SELECT task_uid FROM request_items WHERE request_uid=? AND status='applied')`,
          pool.owner_family_id,
          op.id,
          r.uid,
        ),
      );
    }
    r.statements.push(
      stmt(
        c.env.DB,
        `UPDATE admin_operation_items SET status=i.status,child_request_id=?,outcome_json=json_object('status',i.status,'error',i.error_code,'task_uid',i.task_uid) FROM request_items i WHERE i.request_uid=? AND admin_operation_items.operation_id=? AND admin_operation_items.ordinal=i.ordinal`,
        body.request_id,
        r.uid,
        id,
      ),
    );
    r.statements.push(
      stmt(
        c.env.DB,
        `UPDATE admin_operations SET processed=processed+(SELECT COUNT(*) FROM request_items WHERE request_uid=?),status=CASE WHEN EXISTS(SELECT 1 FROM admin_operation_items WHERE operation_id=? AND status='pending') THEN 'applying' ELSE 'complete' END WHERE id=?`,
        r.uid,
        id,
        id,
      ),
    );
    audit(r, "operation", id, {
      chunk: items.map((i) => i.ordinal),
      action: op.kind === "import" ? "import" : action.kind,
    });
  }
  const result = await commitReceipt(r);
  return {
    operation_id: id,
    items: result.items.map((i) => ({
      ordinal: i.ordinal,
      task_uid: i.task_uid,
      status: i.status,
      error: i.error_code,
    })),
    replayed: result.replayed,
  };
}
async function stageCreates(r: Receipt, rows: Row[], pool: Row) {
  const db = r.env.DB;
  r.statements.push(
    stmt(
      db,
      "UPDATE requests SET guard_config=(SELECT migration_status='ready' FROM pools WHERE id=?) WHERE uid=?",
      pool.id,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `INSERT INTO request_items(request_uid,ordinal,item_id,task_uid,value_json,error_code,status) SELECT ?,json_extract(value,'$.ordinal'),CAST(json_extract(value,'$.ordinal') AS TEXT),json_extract(value,'$.task_uid'),value,json_extract(value,'$.error'),'pending' FROM json_each(?)`,
      r.uid,
      json(rows),
    ),
  );
  r.statements.push(
    stmt(
      db,
      `UPDATE request_items SET error_code=COALESCE(error_code,CASE
    WHEN EXISTS(SELECT 1 FROM task_identifiers ti WHERE ti.pool_id=? AND ti.public_id=json_extract(request_items.value_json,'$.task_id')) THEN 'EDIT_CONFLICT'
    WHEN json_extract(value_json,'$.source_uid') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.task_uid=json_extract(request_items.value_json,'$.source_uid') AND t.edit_revision=json_extract(request_items.value_json,'$.source_revision')) THEN 'EDIT_CONFLICT'
    WHEN (SELECT COUNT(*) FROM request_items du WHERE du.request_uid=request_items.request_uid AND json_extract(du.value_json,'$.task_id')=json_extract(request_items.value_json,'$.task_id'))>1 THEN 'EDIT_CONFLICT' ELSE NULL END) WHERE request_uid=? AND status='pending'`,
      pool.id,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      "UPDATE request_items SET status=CASE WHEN error_code IS NULL THEN 'applied' ELSE 'rejected' END WHERE request_uid=? AND status='pending'",
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `INSERT INTO tasks(task_uid,pool_id,task_id,parameters_json,tags_json,input_hash,input_contract_revision,enabled,created_at,updated_at) SELECT i.task_uid,?,json_extract(i.value_json,'$.task_id'),json_extract(i.value_json,'$.data'),json_extract(i.value_json,'$.tags'),json_extract(i.value_json,'$.hash'),?,json_extract(i.value_json,'$.enabled'),q.accepted_at,q.accepted_at FROM request_items i JOIN requests q ON q.uid=i.request_uid WHERE i.request_uid=? AND i.status='applied' AND json_extract(i.value_json,'$.hash') IS NOT NULL AND json_type(i.value_json,'$.expected_edit_revision') IS NULL`,
      pool.id,
      pool.schema_version,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `INSERT INTO task_identifiers(pool_id,public_id,task_uid) SELECT t.pool_id,t.task_id,t.task_uid FROM tasks t JOIN request_items i ON i.task_uid=t.task_uid WHERE i.request_uid=? AND i.status='applied' AND json_type(i.value_json,'$.expected_edit_revision') IS NULL`,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `INSERT INTO task_tags(task_uid,tag,display) SELECT t.task_uid,j.value,j.value FROM tasks t JOIN request_items i ON i.task_uid=t.task_uid JOIN json_each(t.tags_json) j WHERE i.request_uid=? AND i.status='applied' AND json_type(i.value_json,'$.expected_edit_revision') IS NULL`,
      r.uid,
    ),
  );
}
export async function exportPage(c: Context, id: string) {
  const op = await getOperation(c, id);
  assert(op.kind === "export", "INVALID_VALUE", "Not an export operation.");
  assert(
    op.expires_at > Date.now(),
    "EDIT_CONFLICT",
    "Export expired; create a new selection.",
    409,
  );
  const after = Number(c.url.searchParams.get("after") ?? -1),
    limit = 100;
  assert(Number.isSafeInteger(after) && after >= -1, "INVALID_VALUE", "Invalid export position.");
  const action = JSON.parse(op.action_json);
  if (action.history) {
    const sequence = Number(c.url.searchParams.get("sequence") ?? 0);
    assert(
      Number.isSafeInteger(sequence) && sequence >= 0,
      "INVALID_VALUE",
      "Invalid attempt position.",
    );
    const rows = await all(
      c.env.DB,
      `SELECT a.*,i.ordinal,s.parameters_json,s.tags_json,r.raw_json FROM admin_operation_items i JOIN attempts a ON a.task_uid=i.task_uid JOIN input_snapshots s ON s.id=a.input_snapshot_id LEFT JOIN attempt_results r ON r.attempt_id=a.id WHERE i.operation_id=? AND (i.ordinal>? OR (i.ordinal=? AND a.attempt_sequence>?)) ORDER BY i.ordinal,a.attempt_sequence LIMIT 100`,
      id,
      after,
      after,
      sequence,
    );
    return {
      rows: rows.map(historyDto),
      next: rows.length === limit ? rows.at(-1)!.ordinal : null,
      sequence: rows.at(-1)?.attempt_sequence ?? 0,
      manifest: {
        pool_id: op.pool_id,
        kind: "attempt_history",
        created_at: iso(op.created_at),
        total_tasks: op.total,
        sorts: action.sorts ?? defaultSorts(),
        traversal:
          "Task IDs and sort ordinals are frozen; attempts are read live in frozen task order, then lifetime sequence order.",
      },
    };
  }
  const fields = await fieldsFor(c.env, op.pool_id);
  const resolve = resolverFor(fields, op.profile_id);
  const joins = op.profile_id
    ? `JOIN profiles p ON p.id=${sqlString(op.profile_id)} JOIN families f ON f.id=p.family_id LEFT JOIN task_profile_state ps ON ps.task_uid=t.task_uid AND ps.profile_id=p.id`
    : "";
  const rows = await all(
    c.env.DB,
    `SELECT t.*,i.ordinal,COALESCE(ar.raw_json,li.raw_result_json) raw_json,CASE WHEN ar.raw_json IS NULL AND li.task_uid IS NOT NULL THEN 'imported' ELSE 'worker' END result_provenance,${resolve("status").expression} status,${resolve("status_total").expression} status_total,${resolve("attempts").expression} profile_attempts FROM admin_operation_items i JOIN tasks t ON t.task_uid=i.task_uid JOIN pools po ON po.id=t.pool_id ${joins} LEFT JOIN attempt_results ar ON ar.attempt_id=t.result_attempt_id LEFT JOIN legacy_imports li ON li.task_uid=t.task_uid WHERE i.operation_id=? AND i.ordinal>? ORDER BY i.ordinal LIMIT ?`,
    id,
    after,
    limit,
  );
  return {
    rows: rows.map((t) => ({
      ...taskDto(t),
      raw_result: t.raw_json ? JSON.parse(t.raw_json) : null,
      result_provenance: t.result_provenance,
      ordinal: t.ordinal,
    })),
    next: rows.length === limit ? rows.at(-1)!.ordinal : null,
    manifest: {
      pool_id: op.pool_id,
      profile_id: op.profile_id,
      created_at: iso(op.created_at),
      selection: JSON.parse(op.selection_json),
      schema_version: 4,
      sorts: action.sorts ?? defaultSorts(),
      fields,
      total: op.total,
      traversal:
        "Selected IDs and sort ordinals are frozen. Values are read live and may change during export.",
    },
  };
}
