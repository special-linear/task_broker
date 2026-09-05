import { z } from "zod";
import {
  AppError,
  assert,
  canonical,
  fieldSchema,
  json,
  normalizeInput,
  sha256,
  validate,
  validateFields,
  type Field,
} from "../shared/core";
import { mutation } from "../shared/contracts";
import {
  actorId,
  all,
  audit,
  beginReceipt,
  commitReceipt,
  configGuard,
  DB_NOW,
  effectiveHeads,
  one,
  stmt,
} from "./db";
import { fieldsFor } from "./model";
import { fieldInsert } from "./configuration";
import type { Context, Row } from "./types";
import { compileFilter, formatFilter, parseFilter, type Ast } from "../shared/filter";
import { resolverFor } from "./model";
export async function schemaPreview(c: Context, poolId: string) {
  const body = validate(
      mutation
        .extend({
          expected_revision: z.number().int().positive(),
          fields: z.array(fieldSchema),
        })
        .strict(),
      c.body,
    ),
    r = await beginReceipt(c.env, c.actor, "schema.preview", poolId, body),
    id = crypto.randomUUID();
  if (!r.existing) {
    validateFields(body.fields);
    const pool = await one(c.env.DB, "SELECT * FROM pools WHERE id=?", poolId);
    assert(pool, "NOT_FOUND", "Pool not found.", 404);
    assert(
      pool.migration_status === "ready",
      "CONFIG_CHANGED",
      "Resume the active schema migration before starting another.",
      409,
    );
    const old = await fieldsFor(c.env, poolId),
      fields = body.fields.map((f, i) => ({
        ...f,
        id: f.id ?? crypto.randomUUID(),
        position: i,
      }));
    const semantic = (f: Field) => ({
      key: f.key,
      type: f.type,
      kind: f.kind,
      nullable: f.nullable,
      required: f.required,
      pointer: f.pointer ?? null,
      active: f.active,
    });
    const incompatible =
      old.some((f) => {
        const next = fields.find((n) => n.id === f.id);
        return !next || canonical(semantic(f)) !== canonical(semantic(next));
      }) || fields.some((f) => !old.some((o) => o.id === f.id) && f.kind === "input" && f.required);
    const profiles = await all(c.env.DB, "SELECT * FROM profiles WHERE pool_id=?", poolId);
    const profileUpdates = profiles.map((p) => {
      const remapKey = (key: string) => {
        const previous = old.find(
          (f) =>
            f.key.toLowerCase() === key.toLowerCase() ||
            f.label.toLowerCase() === key.toLowerCase(),
        );
        return previous ? (fields.find((f) => f.id === previous.id)?.key ?? null) : key;
      };
      const remap = (ast: Ast | null): Ast | null => {
        if (!ast) return null;
        if (ast.kind === "and" || ast.kind === "or")
          return { ...ast, left: remap(ast.left)!, right: remap(ast.right)! };
        if (ast.kind === "not") return { ...ast, child: remap(ast.child)! };
        if (ast.kind === "test") {
          const key = remapKey(ast.field);
          assert(
            key,
            "INVALID_VALUE",
            `Profile ${p.name} filters a removed field. Update that mandatory filter before removing the field.`,
          );
          return { ...ast, field: key };
        }
        return ast;
      };
      const filter = remap(parseFilter(p.mandatory_filter));
      compileFilter(filter, resolverFor(fields, p.id));
      return {
        id: p.id,
        revision: p.config_revision,
        mandatory_filter: formatFilter(filter),
        projection:
          p.projection_json === null
            ? null
            : JSON.parse(p.projection_json).map(remapKey).filter(Boolean),
        allowlist: JSON.parse(p.filter_allowlist_json).map(remapKey).filter(Boolean),
      };
    });
    configGuard(r, [{ table: "pools", id: poolId, revision: body.expected_revision }]);
    r.statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO admin_operations(id,actor,kind,pool_id,action_json,created_at,expires_at) VALUES(?,?,'schema',?,?,${DB_NOW},${DB_NOW}+86400000)`,
        id,
        actorId(c.actor),
        poolId,
        json({
          fields,
          old_fields: old,
          profile_updates: profileUpdates,
          expected_revision: body.expected_revision,
          target_version: body.expected_revision + 1,
          incompatible,
        }),
      ),
    );
    if (incompatible)
      r.statements.push(
        stmt(
          c.env.DB,
          `INSERT INTO admin_operation_items(operation_id,ordinal,task_uid,expected_edit_revision,expected_input_revision,expected_state_revision,expected_generation) SELECT ?,row_number() OVER(ORDER BY task_uid)-1,task_uid,edit_revision,input_revision,state_revision,lease_generation FROM tasks WHERE pool_id=?`,
          id,
          poolId,
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
    audit(r, "schema", poolId, {
      operation_id: id,
      incompatible,
      before: old,
      after: fields,
    });
    return JSON.parse(
      (
        await commitReceipt(r, {
          operation_id: id,
          incompatible,
          explanation: incompatible
            ? "Claims and payload edits will be blocked while rows migrate. Values must validate under the new types. Corrections are explicit."
            : "Presentation changes and optional additions apply atomically without rewriting task inputs.",
        })
      ).receipt.metadata_json,
    );
  }
  return JSON.parse((await commitReceipt(r)).receipt.metadata_json);
}
export async function schemaApply(c: Context, poolId: string) {
  const body = validate(
      mutation
        .extend({
          operation_id: z.string().uuid(),
          revoke: z.boolean().default(false),
        })
        .strict(),
      c.body,
    ),
    op = await one(
      c.env.DB,
      "SELECT * FROM admin_operations WHERE id=? AND pool_id=? AND kind='schema' AND actor=?",
      body.operation_id,
      poolId,
      actorId(c.actor),
    );
  assert(op, "NOT_FOUND", "Schema operation not found.", 404);
  const action = JSON.parse(op.action_json),
    r = await beginReceipt(c.env, c.actor, "schema.apply", op.id, body);
  if (r.existing) return JSON.parse((await commitReceipt(r)).receipt.metadata_json);
  assert(
    ["preview", "applying", "complete"].includes(op.status),
    "EDIT_CONFLICT",
    "This schema preview was cancelled.",
    409,
  );
  const db = c.env.DB,
    pool = (await one(db, "SELECT * FROM pools WHERE id=?", poolId))!;
  if (op.status === "preview") {
    assert(op.expires_at > Date.now(), "EDIT_CONFLICT", "Refresh the expired schema preview.", 409);
    configGuard(r, [{ table: "pools", id: poolId, revision: action.expected_revision }]);
    r.statements.push(
      stmt(
        db,
        "UPDATE requests SET guard_config=NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN profiles p ON p.id=json_extract(j.value,'$.id') WHERE p.id IS NULL OR p.config_revision!=json_extract(j.value,'$.revision')) WHERE uid=?",
        json(action.profile_updates ?? []),
        r.uid,
      ),
    );
    if (action.incompatible) {
      r.statements.push(
        stmt(
          db,
          `UPDATE requests SET guard_config=NOT EXISTS(SELECT 1 FROM tasks t LEFT JOIN admin_operation_items i ON i.task_uid=t.task_uid AND i.operation_id=? WHERE t.pool_id=? AND (i.task_uid IS NULL OR t.edit_revision!=i.expected_edit_revision OR t.input_revision!=i.expected_input_revision OR t.state_revision!=i.expected_state_revision OR t.lease_generation!=i.expected_generation)) WHERE uid=?`,
          op.id,
          poolId,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `UPDATE requests SET guard_config=(? OR NOT EXISTS(SELECT 1 FROM (${effectiveHeads(DB_NOW, "(SELECT active_epoch FROM installation WHERE id=1)")}) h WHERE h.pool_id=?)) WHERE uid=?`,
          body.revoke,
          poolId,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          "UPDATE pools SET migration_status='migrating',config_revision=config_revision+1 WHERE id=?",
          poolId,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `INSERT INTO schema_versions(pool_id,version,fields_json,provenance_json,created_at) VALUES(?,?,?,?,${DB_NOW}) ON CONFLICT(pool_id,version) DO NOTHING`,
          poolId,
          action.target_version,
          json(action.fields),
          json({ operation_id: op.id, prior_revision: action.expected_revision }),
        ),
      );
      r.statements.push(
        stmt(db, "UPDATE admin_operations SET status='applying' WHERE id=?", op.id),
      );
      audit(r, "schema", poolId, { started: op.id, revoke: body.revoke });
      return JSON.parse(
        (
          await commitReceipt(r, {
            status: "migrating",
            operation_id: op.id,
            processed: 0,
            total: op.total,
          })
        ).receipt.metadata_json,
      );
    }
  }
  if (action.incompatible && op.status === "applying") {
    const items = await all(
      db,
      "SELECT i.*,t.parameters_json,t.tags_json,t.input_revision,t.input_hash,t.input_contract_revision FROM admin_operation_items i JOIN tasks t ON t.task_uid=i.task_uid WHERE i.operation_id=? AND i.status='pending' ORDER BY i.ordinal LIMIT 50",
      op.id,
    );
    const prepared: Row[] = [];
    for (const i of items) {
      const old = JSON.parse(i.parameters_json),
        override = i.payload_json ? JSON.parse(i.payload_json) : null,
        data: Record<string, unknown> = {};
      let error: string | null = null;
      for (const f of action.fields as Field[])
        if (f.kind === "input") {
          const previous = (action.old_fields as Field[]).find((o) => o.id === f.id),
            key = previous?.key ?? f.key;
          if (override && Object.hasOwn(override, f.key)) data[f.key] = override[f.key];
          else if (Object.hasOwn(old, key)) data[f.key] = old[key];
          else if (f.default !== undefined) data[f.key] = f.default;
        }
      let normalized: Record<string, unknown> = {};
      try {
        normalized = normalizeInput(data, action.fields);
      } catch (e) {
        error = e instanceof Error ? e.message : "Invalid converted inputs.";
      }
      prepared.push({
        ordinal: i.ordinal,
        task_uid: i.task_uid,
        data: normalized,
        hash: await sha256(canonical({ data: normalized, tags: JSON.parse(i.tags_json) })),
        error,
      });
    }
    if (items.length) {
      r.statements.push(
        stmt(
          db,
          "UPDATE requests SET guard_config=NOT EXISTS(SELECT 1 FROM admin_operation_items WHERE operation_id=? AND ordinal IN(SELECT value FROM json_each(?)) AND status!='pending') WHERE uid=?",
          op.id,
          json(items.map((i) => i.ordinal)),
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `INSERT INTO request_items(request_uid,ordinal,task_uid,value_json,error_code,status) SELECT ?,json_extract(value,'$.ordinal'),json_extract(value,'$.task_uid'),value,json_extract(value,'$.error'),CASE WHEN json_extract(value,'$.error') IS NULL THEN 'applied' ELSE 'rejected' END FROM json_each(?)`,
          r.uid,
          json(prepared),
        ),
      );
      r.statements.push(
        stmt(
          db,
          `INSERT INTO input_snapshots(id,task_uid,input_revision,input_hash,parameters_json,tags_json,schema_version) SELECT t.task_uid||':'||t.input_revision,t.task_uid,t.input_revision,t.input_hash,t.parameters_json,t.tags_json,t.input_contract_revision FROM tasks t JOIN request_items i ON i.task_uid=t.task_uid WHERE i.request_uid=? AND i.status='applied' ON CONFLICT(task_uid,input_revision,input_hash) DO NOTHING`,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `UPDATE attempts SET revoked_at=${DB_NOW},revoke_reason='schema migration' WHERE outcome IS NULL AND revoked_at IS NULL AND id IN(SELECT t.latest_attempt_id FROM tasks t JOIN request_items i ON i.task_uid=t.task_uid WHERE i.request_uid=? AND i.status='applied')`,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `INSERT INTO attempt_events(id,attempt_id,kind,timestamp,request_id,metadata_json) SELECT ?||':'||h.attempt_id,h.attempt_id,'revoke',${DB_NOW},?,'{"reason":"schema migration"}' FROM lease_heads h JOIN request_items i ON i.task_uid=h.task_uid WHERE i.request_uid=? AND i.status='applied'`,
          r.uid,
          body.request_id,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          "DELETE FROM lease_heads WHERE task_uid IN(SELECT task_uid FROM request_items WHERE request_uid=? AND status='applied')",
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `UPDATE tasks SET lease_generation=lease_generation+1,state_revision=state_revision+1,parameters_json=json_extract(i.value_json,'$.data'),input_hash=json_extract(i.value_json,'$.hash'),input_revision=input_revision+1,edit_revision=edit_revision+1,input_contract_revision=?,updated_at=${DB_NOW},completed_at=NULL,previous_result=CASE WHEN result_summary_json IS NULL THEN 0 ELSE 1 END FROM request_items i WHERE i.request_uid=? AND i.status='applied' AND tasks.task_uid=i.task_uid`,
          action.target_version,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          "UPDATE admin_operation_items SET status=i.status,outcome_json=json_object('error',i.error_code) FROM request_items i WHERE i.request_uid=? AND admin_operation_items.operation_id=? AND admin_operation_items.ordinal=i.ordinal",
          r.uid,
          op.id,
        ),
      );
      r.statements.push(
        stmt(
          db,
          "UPDATE admin_operations SET processed=(SELECT COUNT(*) FROM admin_operation_items WHERE operation_id=? AND status='applied') WHERE id=?",
          op.id,
          op.id,
        ),
      );
      audit(r, "schema", poolId, {
        operation_id: op.id,
        chunk: items.map((i) => i.ordinal),
      });
      return JSON.parse(
        (
          await commitReceipt(r, {
            status: prepared.some((i) => i.error) ? "needs_correction" : "migrating",
            operation_id: op.id,
            errors: prepared
              .filter((i) => i.error)
              .map((i) => ({ task_uid: i.task_uid, error: i.error })),
            processed: op.processed + prepared.filter((i) => !i.error).length,
            total: op.total,
          })
        ).receipt.metadata_json,
      );
    }
    const failed = await all(
      db,
      "SELECT task_uid,outcome_json FROM admin_operation_items WHERE operation_id=? AND status='rejected' LIMIT 100",
      op.id,
    );
    if (failed.length)
      return JSON.parse(
        (
          await commitReceipt(r, {
            status: "needs_correction",
            operation_id: op.id,
            errors: failed.map((i) => ({
              task_uid: i.task_uid,
              error: JSON.parse(i.outcome_json).error,
            })),
          })
        ).receipt.metadata_json,
      );
  }
  if (op.status === "complete")
    return JSON.parse(
      (await commitReceipt(r, { status: "complete", operation_id: op.id })).receipt.metadata_json,
    );
  r.statements.push(
    stmt(db, "DELETE FROM pool_fields WHERE pool_id=?", poolId),
    fieldInsert(c, action.fields, poolId),
  );
  r.statements.push(
    stmt(
      db,
      "UPDATE profiles SET mandatory_filter=json_extract(j.value,'$.mandatory_filter'),projection_json=CASE WHEN json_type(j.value,'$.projection')='null' THEN NULL ELSE json_extract(j.value,'$.projection') END,filter_allowlist_json=json_extract(j.value,'$.allowlist'),config_revision=config_revision+1 FROM json_each(?) j WHERE profiles.id=json_extract(j.value,'$.id')",
      json(action.profile_updates ?? []),
    ),
  );
  r.statements.push(
    stmt(
      db,
      `INSERT INTO schema_versions(pool_id,version,fields_json,provenance_json,created_at) VALUES(?,?,?,?,${DB_NOW}) ON CONFLICT(pool_id,version) DO NOTHING`,
      poolId,
      action.target_version,
      json(action.fields),
      json({ operation_id: op.id, prior_revision: action.expected_revision }),
    ),
  );
  r.statements.push(
    stmt(
      db,
      "UPDATE pools SET schema_version=?,migration_status='ready',config_revision=config_revision+1 WHERE id=?",
      action.target_version,
      poolId,
    ),
  );
  r.statements.push(stmt(db, "UPDATE admin_operations SET status='complete' WHERE id=?", op.id));
  audit(r, "schema", poolId, { activated: action.target_version });
  return JSON.parse(
    (await commitReceipt(r, { status: "complete", operation_id: op.id })).receipt.metadata_json,
  );
}
export async function schemaCorrect(c: Context, poolId: string) {
  const body = validate(
      mutation
        .extend({
          operation_id: z.string().uuid(),
          task_uid: z.string().uuid(),
          data: z.record(z.string(), z.unknown()),
        })
        .strict(),
      c.body,
    ),
    op = await one(
      c.env.DB,
      "SELECT * FROM admin_operations WHERE id=? AND pool_id=? AND actor=? AND kind='schema' AND status='applying'",
      body.operation_id,
      poolId,
      actorId(c.actor),
    );
  assert(op, "NOT_FOUND", "Active schema migration not found.", 404);
  const data = normalizeInput(body.data, JSON.parse(op.action_json).fields),
    r = await beginReceipt(c.env, c.actor, "schema.correct", op.id, body);
  if (!r.existing) {
    r.statements.push(
      stmt(
        c.env.DB,
        "UPDATE admin_operation_items SET payload_json=?,status='pending',outcome_json=NULL WHERE operation_id=? AND task_uid=? AND status='rejected'",
        json(data),
        op.id,
        body.task_uid,
      ),
    );
    audit(r, "schema", poolId, { corrected_task: body.task_uid, data });
  }
  return JSON.parse((await commitReceipt(r, { corrected: true })).receipt.metadata_json);
}
