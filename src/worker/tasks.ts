import {
  querySorts,
  resolveSorts,
  sortSpec,
  sortOrder,
  sortProjection,
  sortAfter,
} from "../shared/sort";
import { sortResolver } from "./sorting";
import { recordDto } from "./presentation";
import {
  AppError,
  assert,
  canonical,
  iso,
  json,
  normalizeInput,
  normalizeTags,
  sha256,
  validate,
  type Field,
} from "../shared/core";
import { editSchema, taskCreateSchema, type TaskPatch } from "../shared/contracts";
import { compileFilter, parseFilter, sqlString } from "../shared/filter";
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
import { fieldsFor, globalStatus, resolverFor, taskDto } from "./model";
import { decodeCursor, encodeCursor } from "./pagination";
import type { Context, Env, Row } from "./types";

export async function getTask(env: Env, uid: string) {
  const status = globalStatus(DB_NOW, sqlString(env.INSTANCE_EPOCH));
  const row = await one(
    env.DB,
    `SELECT t.*,po.migration_status,${status} status,(SELECT expires_at FROM (${effectiveHeads(DB_NOW, sqlString(env.INSTANCE_EPOCH))}) h WHERE h.task_uid=t.task_uid) expires_at FROM tasks t JOIN pools po ON po.id=t.pool_id WHERE t.task_uid=?`,
    uid,
  );
  assert(row, "NOT_FOUND", "Task not found.", 404);
  return row;
}
export async function listTasks(c: Context, poolId: string) {
  const fields = await fieldsFor(c.env, poolId),
    pool = await one(c.env.DB, "SELECT * FROM pools WHERE id=?", poolId);
  assert(pool, "NOT_FOUND", "Pool not found.", 404);
  const filter = c.url.searchParams.get("filter") ?? "",
    profileId = c.url.searchParams.get("profile_id");
  if (profileId)
    assert(
      await one(c.env.DB, "SELECT id FROM profiles WHERE id=? AND pool_id=?", profileId, poolId),
      "INVALID_VALUE",
      "Profile does not belong to this pool.",
    );
  const resolve = resolverFor(fields, profileId),
    compiled = compileFilter(parseFilter(filter), resolve, 1),
    sorts = resolveSorts(querySorts(c.url.searchParams), sortResolver(fields, profileId));
  const limit = Math.min(250, Math.max(1, Number(c.url.searchParams.get("limit") ?? 100)));
  assert(Number.isInteger(limit), "BAD_REQUEST", "Invalid page size.", 400);
  const scope = {
      poolId,
      profileId,
      filter,
      sorts: sortSpec(sorts),
      schema_version: pool.schema_version,
      cursor_version: 2,
      limit,
      include_deleted: c.url.searchParams.get("include_deleted") === "true",
    },
    cursor = c.url.searchParams.get("cursor");
  const last = cursor ? await decodeCursor(c.env, cursor, scope) : null;
  const totalStatus = globalStatus(DB_NOW, sqlString(c.env.INSTANCE_EPOCH));
  const joins = profileId
    ? `JOIN profiles p ON p.id=${sqlString(profileId)} JOIN families f ON f.id=p.family_id LEFT JOIN task_profile_state ps ON ps.task_uid=t.task_uid AND ps.profile_id=p.id`
    : "";
  const status = resolve("status").expression;
  const after = last ? `AND (${sortAfter(sorts, last)})` : "";
  const where = `t.pool_id=${sqlString(poolId)} ${c.url.searchParams.get("include_deleted") === "true" ? "" : "AND t.deleted_at IS NULL"} AND (${compiled.sql})`;
  const rows = await all(
    c.env.DB,
    `SELECT t.*,${status} status,${totalStatus} status_total,${profileId ? "COALESCE(ps.attempts,0)" : "t.attempts_total"} profile_attempts,${sorts.length ? sortProjection(sorts) + "," : ""}(SELECT expires_at FROM (${effectiveHeads(DB_NOW, sqlString(c.env.INSTANCE_EPOCH))}) h WHERE h.task_uid=t.task_uid) expires_at FROM tasks t JOIN pools po ON po.id=t.pool_id ${joins} WHERE ${where} ${after} ORDER BY ${sortOrder(sorts)} LIMIT ${limit + 1}`,
    ...compiled.params,
  );
  const page = rows.slice(0, limit),
    tail = page.at(-1);
  const count = await one(
    c.env.DB,
    `SELECT COUNT(*) count FROM tasks t JOIN pools po ON po.id=t.pool_id ${joins} WHERE ${where}`,
    ...compiled.params,
  );
  const requested = c.url.searchParams
    .get("fields")
    ?.split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const projected = page.map(taskDto);
  if (requested)
    for (const key of requested)
      assert(
        fields.some((f) => f.key === key) ||
          Object.hasOwn(taskDto({ ...page[0], tags_json: "[]", parameters_json: "{}" }), key),
        "INVALID_VALUE",
        `Unknown selected field ${key}.`,
      );
  return {
    rows: requested
      ? projected.map((row) =>
          Object.fromEntries(
            Object.entries(row)
              .filter(
                ([key]) =>
                  [
                    "task_uid",
                    "pool_id",
                    "task_id",
                    "edit_revision",
                    "input_revision",
                    "state_revision",
                    "lease_generation",
                    "data",
                    "result",
                  ].includes(key) || requested.includes(key),
              )
              .map(([key, value]) => [
                key,
                ["data", "result"].includes(key) && value !== null
                  ? Object.fromEntries(
                      Object.entries(value as Record<string, unknown>).filter(
                        ([name]) => requested.includes(key) || requested.includes(name),
                      ),
                    )
                  : value,
              ]),
          ),
        )
      : projected,
    fields: requested
      ? fields.filter(
          (f) =>
            requested.includes(f.key) || requested.includes(f.kind === "input" ? "data" : "result"),
        )
      : fields,
    pool: recordDto(pool),
    total: count!.count,
    counted_at: new Date().toISOString(),
    cursor:
      rows.length > limit
        ? await encodeCursor(c.env, scope, {
            values: sorts.map((_, i) => tail![`sort_${i}`]),
            uid: tail!.task_uid,
          })
        : null,
  };
}
export async function createTask(c: Context, poolId: string) {
  const body = validate(taskCreateSchema, c.body),
    pool = await one(c.env.DB, "SELECT * FROM pools WHERE id=?", poolId);
  assert(pool, "NOT_FOUND", "Pool not found.", 404);
  const r = await beginReceipt(c.env, c.actor, "task.create", poolId, body);
  if (r.existing) return JSON.parse((await commitReceipt(r)).receipt.metadata_json);
  const fields = await fieldsFor(c.env, poolId),
    uid = crypto.randomUUID(),
    id = body.task_id ?? crypto.randomUUID(),
    data = normalizeInput(body.data, fields, true),
    tags = normalizeTags(body.tags),
    hash = await sha256(canonical({ data, tags }));
  configGuard(r, [{ table: "pools", id: poolId, revision: pool.config_revision }]);
  r.statements.push(
    stmt(
      c.env.DB,
      "UPDATE requests SET guard_config=(SELECT migration_status='ready' FROM pools WHERE id=?) WHERE uid=?",
      poolId,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      c.env.DB,
      `INSERT INTO tasks(task_uid,pool_id,task_id,parameters_json,tags_json,input_hash,input_contract_revision,enabled,admin_note,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,accepted_at,accepted_at FROM requests WHERE uid=?`,
      uid,
      poolId,
      id,
      json(data),
      json(tags),
      hash,
      pool.schema_version,
      body.enabled,
      body.admin_note,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      c.env.DB,
      "INSERT INTO task_identifiers(pool_id,public_id,task_uid) VALUES(?,?,?)",
      poolId,
      id,
      uid,
    ),
  );
  r.statements.push(
    stmt(
      c.env.DB,
      "INSERT INTO task_tags(task_uid,tag,display) SELECT ?,value,value FROM json_each(?)",
      uid,
      json(tags),
    ),
  );
  audit(r, "task", uid, { created: { task_id: id, data, tags } });
  const result = await commitReceipt(r, { task_uid: uid, task_id: id });
  return JSON.parse(result.receipt.metadata_json);
}
export type EditItem = {
  task: Row;
  expected_edit_revision: number;
  expected_input_revision?: number;
  expected_state_revision?: number;
  expected_generation?: number;
  patch?: TaskPatch;
  kind?: string;
  mode?: string;
  scope?: string;
  profile_id?: string;
  revoke?: boolean;
  ordinal?: number;
  error?: string;
  operation_id?: string;
};
export async function stageTaskChanges(r: Receipt, items: EditItem[], fields: Field[]) {
  const prepared: Row[] = [];
  for (let ix = 0; ix < items.length; ix++) {
    const i = items[ix],
      t = i.task,
      p = i.patch ?? {},
      kind = i.kind ?? "edit";
    let error = i.error ?? null;
    let data = JSON.parse(t.parameters_json),
      tags = JSON.parse(t.tags_json),
      hash = t.input_hash;
    const input = !!(p.data || p.unset || p.tags);
    try {
      if (p.data) data = { ...data, ...p.data };
      if (p.unset)
        for (const k of p.unset) {
          const f = fields.find((f) => f.key === k && f.kind === "input");
          assert(f && !f.required, "INVALID_VALUE", `Cannot unset required or unknown field ${k}.`);
          delete data[k];
        }
      if (input) {
        data = normalizeInput(data, fields);
        tags = p.tags ? normalizeTags(p.tags) : tags;
        hash = await sha256(canonical({ data, tags }));
      }
    } catch (e) {
      error = e instanceof AppError ? e.code : "INVALID_VALUE";
    }
    prepared.push({
      ordinal: i.ordinal ?? ix,
      task_uid: t.task_uid,
      expected_edit_revision: i.expected_edit_revision,
      expected_input_revision: i.expected_input_revision ?? t.input_revision,
      expected_state_revision: i.expected_state_revision ?? null,
      expected_generation: i.expected_generation ?? null,
      operation_id: i.operation_id ?? null,
      kind,
      mode: i.mode ?? "soft",
      scope: i.scope ?? "all",
      profile_id: i.profile_id ?? null,
      revoke: !!i.revoke,
      patch: p,
      before: {
        task_id: t.task_id,
        data: JSON.parse(t.parameters_json),
        tags: JSON.parse(t.tags_json),
        enabled: !!t.enabled,
        admin_note: t.admin_note,
        max_attempts: t.max_attempts_set ? t.max_attempts : "inherit",
      },
      input,
      data,
      tags,
      hash,
      error,
    });
  }
  const db = r.env.DB,
    time = `(SELECT accepted_at FROM requests WHERE uid=${sqlString(r.uid)})`,
    active = `EXISTS(SELECT 1 FROM (${effectiveHeads(time, sqlString(r.env.INSTANCE_EPOCH))}) h WHERE h.task_uid=t.task_uid)`;
  r.statements.push(
    stmt(
      db,
      `INSERT INTO request_items(request_uid,ordinal,item_id,task_uid,value_json,error_code) SELECT ?,json_extract(value,'$.ordinal'),CAST(json_extract(value,'$.ordinal') AS TEXT),json_extract(value,'$.task_uid'),value,json_extract(value,'$.error') FROM json_each(?)`,
      r.uid,
      json(prepared),
    ),
  );
  r.statements.push(
    stmt(
      db,
      `UPDATE request_items SET error_code=COALESCE(error_code,(SELECT CASE
    WHEN t.task_uid IS NULL THEN 'NOT_FOUND'
    WHEN t.edit_revision!=json_extract(i.value_json,'$.expected_edit_revision') OR t.input_revision!=json_extract(i.value_json,'$.expected_input_revision') THEN 'EDIT_CONFLICT'
    WHEN json_extract(i.value_json,'$.expected_generation') IS NOT NULL AND (t.lease_generation!=json_extract(i.value_json,'$.expected_generation') OR t.state_revision!=json_extract(i.value_json,'$.expected_state_revision')) THEN 'EDIT_CONFLICT'
    WHEN po.migration_status!='ready' AND json_extract(i.value_json,'$.input')=1 THEN 'CONFIG_CHANGED'
    WHEN json_extract(i.value_json,'$.patch.task_id') IS NOT NULL AND json_extract(i.value_json,'$.patch.task_id')!=t.task_id AND (t.attempt_sequence>0 OR t.lifetime_attempts>0 OR EXISTS(SELECT 1 FROM legacy_imports li WHERE li.task_uid=t.task_uid) OR EXISTS(SELECT 1 FROM task_identifiers ti WHERE ti.pool_id=t.pool_id AND ti.public_id=json_extract(i.value_json,'$.patch.task_id'))) THEN 'EDIT_CONFLICT'
    WHEN ${active} AND (json_extract(i.value_json,'$.input')=1 OR json_extract(i.value_json,'$.kind') IN('delete','reset','revoke','revoke_edit','reset_edit')) AND json_extract(i.value_json,'$.revoke')!=1 THEN 'TASK_LEASED'
    WHEN t.completed_at IS NOT NULL AND json_extract(i.value_json,'$.input')=1 AND json_extract(i.value_json,'$.kind')!='reset_edit' THEN 'TASK_COMPLETED'
    ELSE NULL END FROM request_items i LEFT JOIN tasks t ON t.task_uid=i.task_uid LEFT JOIN pools po ON po.id=t.pool_id WHERE i.request_uid=request_items.request_uid AND i.ordinal=request_items.ordinal)) WHERE request_uid=?`,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      "UPDATE request_items SET status=CASE WHEN error_code IS NULL THEN 'applied' ELSE 'rejected' END WHERE request_uid=?",
      r.uid,
    ),
  );
  const accepted = `SELECT task_uid FROM request_items WHERE request_uid=${sqlString(r.uid)} AND status='applied'`;
  const invalidates =
    "(json_extract(i.value_json,'$.input')=1 OR json_extract(i.value_json,'$.kind') IN('delete','reset','revoke','revoke_edit','reset_edit'))";
  r.statements.push(
    stmt(
      db,
      `UPDATE attempts SET revoked_at=${time},revoke_reason=json_extract(i.value_json,'$.kind') FROM request_items i JOIN tasks t ON t.task_uid=i.task_uid WHERE i.request_uid=? AND i.status='applied' AND ${invalidates} AND attempts.id=t.latest_attempt_id AND attempts.outcome IS NULL AND attempts.revoked_at IS NULL`,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `INSERT INTO attempt_events(id,attempt_id,kind,timestamp,request_id,metadata_json) SELECT i.request_uid||':revoke:'||i.ordinal,t.latest_attempt_id,'revoke',${time},?,json_object('reason',json_extract(i.value_json,'$.kind')) FROM request_items i JOIN tasks t ON t.task_uid=i.task_uid JOIN attempts a ON a.id=t.latest_attempt_id WHERE i.request_uid=? AND i.status='applied' AND ${invalidates} AND a.revoked_at=${time}`,
      r.body.request_id,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `DELETE FROM lease_heads WHERE task_uid IN(SELECT i.task_uid FROM request_items i WHERE i.request_uid=? AND i.status='applied' AND ${invalidates})`,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `UPDATE task_identifiers SET active=0 WHERE task_uid IN(SELECT i.task_uid FROM request_items i JOIN tasks t ON t.task_uid=i.task_uid WHERE i.request_uid=? AND i.status='applied' AND json_extract(i.value_json,'$.patch.task_id') IS NOT NULL AND json_extract(i.value_json,'$.patch.task_id')!=t.task_id)`,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `INSERT INTO task_identifiers(pool_id,public_id,task_uid) SELECT t.pool_id,json_extract(i.value_json,'$.patch.task_id'),t.task_uid FROM request_items i JOIN tasks t ON t.task_uid=i.task_uid WHERE i.request_uid=? AND i.status='applied' AND json_extract(i.value_json,'$.patch.task_id') IS NOT NULL AND json_extract(i.value_json,'$.patch.task_id')!=t.task_id`,
      r.uid,
    ),
  );
  const reset = "json_extract(i.value_json,'$.kind') IN('reset','reset_edit')",
    allScope = "json_extract(i.value_json,'$.scope')='all'",
    full = "json_extract(i.value_json,'$.mode')='full'";
  r.statements.push(
    stmt(
      db,
      `UPDATE tasks SET parameters_json=json_extract(i.value_json,'$.data'),tags_json=json_extract(i.value_json,'$.tags'),input_hash=json_extract(i.value_json,'$.hash'),
    input_contract_revision=CASE WHEN json_extract(i.value_json,'$.input')=1 THEN (SELECT schema_version FROM pools WHERE id=tasks.pool_id) ELSE tasks.input_contract_revision END,input_revision=input_revision+json_extract(i.value_json,'$.input'),edit_revision=edit_revision+1,state_revision=state_revision+CASE WHEN ${invalidates} THEN 1 ELSE 0 END,
    lease_generation=lease_generation+CASE WHEN ${invalidates} THEN 1 ELSE 0 END,
    task_id=COALESCE(json_extract(i.value_json,'$.patch.task_id'),tasks.task_id),enabled=COALESCE(json_extract(i.value_json,'$.patch.enabled'),tasks.enabled),admin_note=COALESCE(json_extract(i.value_json,'$.patch.admin_note'),tasks.admin_note),
    max_attempts_set=CASE WHEN json_type(i.value_json,'$.patch.max_attempts') IS NOT NULL THEN CASE WHEN json_extract(i.value_json,'$.patch.max_attempts')='inherit' THEN 0 ELSE 1 END ELSE tasks.max_attempts_set END,max_attempts=CASE WHEN json_type(i.value_json,'$.patch.max_attempts') IS NOT NULL THEN CASE WHEN json_extract(i.value_json,'$.patch.max_attempts')='inherit' THEN NULL ELSE json_extract(i.value_json,'$.patch.max_attempts') END ELSE tasks.max_attempts END,
    deleted_at=CASE WHEN json_extract(i.value_json,'$.kind')='delete' THEN ${time} WHEN json_extract(i.value_json,'$.kind')='restore' THEN NULL ELSE tasks.deleted_at END,
    completed_at=CASE WHEN ${reset} AND ${allScope} THEN NULL ELSE tasks.completed_at END,
    attempts_total=CASE WHEN ${reset} AND ${allScope} AND ${full} THEN 0 ELSE tasks.attempts_total END,
    result_summary_json=CASE WHEN ${reset} AND ${allScope} AND ${full} THEN NULL ELSE tasks.result_summary_json END,
    result_attempt_id=CASE WHEN ${reset} AND ${allScope} AND ${full} THEN NULL ELSE tasks.result_attempt_id END,
    previous_result=CASE WHEN ${reset} AND ${allScope} THEN CASE WHEN ${full} THEN 0 ELSE 1 END ELSE tasks.previous_result END,updated_at=${time}
    FROM request_items i WHERE i.request_uid=? AND i.status='applied' AND tasks.task_uid=i.task_uid`,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `UPDATE task_profile_state SET permanent_failure=0,failure_message=NULL,failure_details_json=NULL,attempts=CASE WHEN ${full} THEN 0 ELSE attempts END,reset_at=${time} FROM request_items i WHERE i.request_uid=? AND i.status='applied' AND ${reset} AND task_profile_state.task_uid=i.task_uid AND (${allScope} OR task_profile_state.profile_id=json_extract(i.value_json,'$.profile_id'))`,
      r.uid,
    ),
  );
  r.statements.push(stmt(db, `DELETE FROM task_tags WHERE task_uid IN(${accepted})`));
  r.statements.push(
    stmt(
      db,
      `INSERT INTO task_tags(task_uid,tag,display) SELECT t.task_uid,j.value,j.value FROM tasks t JOIN json_each(t.tags_json) j WHERE t.task_uid IN(${accepted})`,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `INSERT INTO audit_events(id,actor,email,operation_id,entity_type,entity_id,timestamp,diff_json) SELECT i.request_uid||':audit:'||i.ordinal,?,?,?,'task',i.task_uid,${time},json_object('action',json_extract(i.value_json,'$.kind'),'patch',json(json_extract(i.value_json,'$.patch')),'before',json(json_extract(i.value_json,'$.before')),'expected_edit_revision',json_extract(i.value_json,'$.expected_edit_revision')) FROM request_items i WHERE i.request_uid=? AND i.status='applied'`,
      `${r.actor.kind}:${r.actor.id}`,
      r.actor.kind === "admin" ? r.actor.email : null,
      r.body.request_id,
      r.uid,
    ),
  );
  r.statements.push(
    stmt(
      db,
      `UPDATE request_items SET response_json=(SELECT json_object('task_uid',t.task_uid,'task_id',t.task_id,'pool_id',t.pool_id,'parameters_json',t.parameters_json,'tags_json',t.tags_json,'enabled',t.enabled,'admin_note',t.admin_note,'max_attempts',t.max_attempts,'max_attempts_set',t.max_attempts_set,'edit_revision',t.edit_revision,'input_revision',t.input_revision,'state_revision',t.state_revision,'lease_generation',t.lease_generation,'attempts_total',t.attempts_total,'result_summary_json',t.result_summary_json,'previous_result',t.previous_result,'deleted_at',t.deleted_at,'completed_at',t.completed_at,'status',${globalStatus(time, sqlString(r.env.INSTANCE_EPOCH))}) FROM tasks t JOIN pools po ON po.id=t.pool_id WHERE t.task_uid=request_items.task_uid) WHERE request_uid=?`,
      r.uid,
    ),
  );
}
export async function editTask(c: Context, uid: string) {
  const body = validate(editSchema, c.body),
    r = await beginReceipt(c.env, c.actor, "task.edit", uid, body);
  if (!r.existing) {
    const t = await getTask(c.env, uid),
      pool = (await one(c.env.DB, "SELECT * FROM pools WHERE id=?", t.pool_id))!;
    configGuard(r, [{ table: "pools", id: pool.id, revision: pool.config_revision }]);
    await stageTaskChanges(
      r,
      [
        {
          task: t,
          expected_edit_revision: body.expected_edit_revision,
          expected_input_revision: body.expected_input_revision,
          patch: body.patch,
        },
      ],
      await fieldsFor(c.env, t.pool_id),
    );
  }
  const result = await commitReceipt(r),
    item = result.items[0],
    row = item.response_json ? taskDto(JSON.parse(item.response_json)) : null;
  if (item.status === "rejected")
    throw new AppError(
      item.error_code,
      item.error_code === "TASK_LEASED"
        ? "Use Revoke and edit for leased inputs."
        : item.error_code === "TASK_COMPLETED"
          ? "Use Reset and edit for completed inputs."
          : "The task changed or the edit is invalid.",
      409,
      { current: row },
    );
  return row;
}
export async function taskHistory(c: Context, uid: string) {
  const cursor = c.url.searchParams.get("cursor"),
    scope = { kind: "history", uid },
    last = cursor ? await decodeCursor(c.env, cursor, scope) : null;
  const rows = await all(
    c.env.DB,
    `SELECT a.id,a.task_uid,a.profile_id,a.family_id,a.task_id,a.identity_json,a.attempt_sequence,a.lease_generation,a.instance_epoch,a.worker_id,a.issued_at,a.expires_at,a.maximum_expires_at,a.input_revision,a.input_hash,a.contract_json,a.returned_data_json,a.outcome,a.message,a.details_json,a.mapped_json,a.finalized_at,a.runtime_seconds,a.server_elapsed_seconds,a.runtime_origin,a.late,a.revoked_at,a.revoke_reason,s.parameters_json,s.tags_json,r.raw_json FROM attempts a JOIN input_snapshots s ON s.id=a.input_snapshot_id LEFT JOIN attempt_results r ON r.attempt_id=a.id WHERE a.task_uid=? ${last ? "AND a.attempt_sequence<?" : ""} ORDER BY a.attempt_sequence DESC LIMIT 51`,
    uid,
    ...(last ? [last.sequence] : []),
  );
  const page = rows.slice(0, 50);
  return {
    attempts: page.map(historyDto),
    imported_history: await one(
      c.env.DB,
      "SELECT operation_id,imported_at,source_json,raw_result_json,historical_attempts,imported_completed FROM legacy_imports WHERE task_uid=?",
      uid,
    ).then((row) => (row ? recordDto(row) : null)),
    cursor:
      rows.length > 50
        ? await encodeCursor(c.env, scope, {
            sequence: page.at(-1)!.attempt_sequence,
          })
        : null,
  };
}
export function historyDto(a: Row) {
  return {
    ...a,
    lease_token: undefined,
    issuing_key_id: undefined,
    issued_at: iso(a.issued_at),
    expires_at: iso(a.expires_at),
    maximum_expires_at: iso(a.maximum_expires_at),
    finalized_at: iso(a.finalized_at),
    revoked_at: iso(a.revoked_at),
    input: JSON.parse(a.parameters_json),
    data: JSON.parse(a.returned_data_json),
    tags: JSON.parse(a.tags_json),
    result: a.raw_json ? JSON.parse(a.raw_json) : null,
    contract: JSON.parse(a.contract_json),
    identity: JSON.parse(a.identity_json),
    parameters_json: undefined,
    returned_data_json: undefined,
    tags_json: undefined,
    raw_json: undefined,
    contract_json: undefined,
    identity_json: undefined,
    details: a.details_json ? JSON.parse(a.details_json) : null,
    mapped: a.mapped_json ? JSON.parse(a.mapped_json) : null,
    details_json: undefined,
    mapped_json: undefined,
  };
}
