import {
  AppError,
  assert,
  canonical,
  iso,
  json,
  LIMITS,
  mapResult,
  randomSecret,
  sha256,
  validate,
} from "../shared/core";
import {
  batchSchema,
  claimSchema,
  recoverSchema,
  renewItemSchema,
  reportItemSchema,
  type ItemResult,
} from "../shared/contracts";
import { compileFilter, parseFilter, sqlString } from "../shared/filter";
import {
  all,
  beginReceipt,
  commitReceipt,
  configGuard,
  DB_NOW,
  effectiveHeads,
  one,
  stmt,
} from "./db";
import { attemptDto, resolveProfile, resolverFor } from "./model";
import type { Context, Row } from "./types";

export async function claim(c: Context): Promise<unknown> {
  const body = validate(claimSchema, c.body);
  assert(
    c.actor.kind === "key" && c.actor.status === "active",
    "KEY_REVOKED",
    "An active key is required to claim tasks.",
    403,
  );
  const { profile, pool, family, installation, fields, policy } = await resolveProfile(
    c.env,
    c.actor,
    body.pool,
    body.request_id,
  );
  const r = await beginReceipt(c.env, c.actor, "claim", profile.id, body, {
    keyActive: true,
    retention: (policy.max_lifetime_seconds + 86400) * 1000,
  });
  if (!r.existing) {
    configGuard(r, [
      { table: "profiles", id: profile.id, revision: profile.config_revision },
      { table: "pools", id: pool.id, revision: pool.config_revision },
      { table: "families", id: family.id, revision: family.config_revision },
      {
        table: "installation",
        id: "1",
        revision: installation.config_revision,
      },
    ]);
    const db = c.env.DB,
      time = `(SELECT accepted_at FROM requests WHERE uid=${sqlString(r.uid)})`,
      epoch = sqlString(c.env.INSTANCE_EPOCH);
    const mandatory = compileFilter(
      parseFilter(profile.mandatory_filter),
      resolverFor(fields, profile.id, time, epoch),
      1,
    );
    const requested = compileFilter(
      parseFilter(body.filter),
      resolverFor(fields, profile.id, time, epoch, JSON.parse(profile.filter_allowlist_json)),
      mandatory.params.length + 1,
    );
    const duration = Math.min(
      body.lease_seconds ?? policy.lease_seconds,
      policy.max_lifetime_seconds,
    );
    const draining =
      !profile.enabled ||
      !pool.enabled ||
      !family.enabled ||
      pool.archived_at !== null ||
      pool.migration_status !== "ready";
    const caps = {
      request: Math.min(body.count, policy.claim_cap, LIMITS.claim),
      worker_profile: policy.worker_profile_cap,
      profile: policy.profile_cap,
      pool: pool.active_cap,
      worker_family: policy.worker_family_cap,
      family: policy.family_cap,
    };
    r.statements.push(
      stmt(
        db,
        `WITH active AS MATERIALIZED (${effectiveHeads(time, epoch)}), usage AS (SELECT
      (SELECT COUNT(*) FROM active WHERE profile_id=? AND worker_id=?) worker_profile,
      (SELECT COUNT(*) FROM active WHERE profile_id=?) profile,
      (SELECT COUNT(*) FROM active WHERE pool_id=?) pool,
      (SELECT COUNT(*) FROM active WHERE family_id=? AND worker_id=?) worker_family,
      (SELECT COUNT(*) FROM active WHERE family_id=?) family)
      UPDATE requests SET metadata_json=json_object('canonical_profile_id',?,'requested_count',?,'caps',json(?),'usage',json_object('worker_profile',worker_profile,'profile',profile,'pool',pool,'worker_family',worker_family,'family',family),'draining',?,'grant_limit',CASE WHEN ? THEN 0 ELSE max(0,min(?,COALESCE(?,2147483647)-worker_profile,COALESCE(?,2147483647)-profile,COALESCE(?,2147483647)-pool,COALESCE(?,2147483647)-worker_family,COALESCE(?,2147483647)-family)) END) FROM usage WHERE uid=?`,
        profile.id,
        body.worker_id,
        profile.id,
        pool.id,
        family.id,
        body.worker_id,
        family.id,
        profile.id,
        body.count,
        json(caps),
        Number(draining),
        Number(draining),
        caps.request,
        caps.worker_profile,
        caps.profile,
        caps.pool,
        caps.worker_family,
        caps.family,
        r.uid,
      ),
    );
    const seeds = Array.from({ length: 20 }, () => ({
      id: crypto.randomUUID(),
      token: randomSecret(),
    }));
    const projection =
      profile.projection_json === null
        ? "t.parameters_json"
        : `(SELECT COALESCE(json_group_object(j.key,CASE WHEN j.type IN ('object','array') THEN json(j.value) WHEN j.type='true' THEN json('true') WHEN j.type='false' THEN json('false') ELSE j.value END),'{}') FROM json_each(t.parameters_json) j WHERE j.key IN (SELECT value FROM json_each(${sqlString(profile.projection_json)})))`;
    const contract = json({
      fields,
      required_result: !!pool.required_result,
      schema_version: pool.schema_version,
      max_lifetime_seconds: policy.max_lifetime_seconds,
      projection: profile.projection_json ? JSON.parse(profile.projection_json) : null,
    });
    const extra = mandatory.params.length + requested.params.length;
    const grantLimit = `(SELECT json_extract(metadata_json,'$.grant_limit') FROM requests WHERE uid=${sqlString(r.uid)})`;
    const eligibility = `t.pool_id=${sqlString(pool.id)} AND t.enabled=1 AND t.deleted_at IS NULL AND t.completed_at IS NULL AND t.valid=1 AND t.input_contract_revision<=${pool.schema_version}
      AND COALESCE(ps.permanent_failure,0)=0
      AND ((CASE WHEN t.max_attempts_set=1 THEN t.max_attempts ELSE ${policy.max_attempts ?? "NULL"} END) IS NULL OR COALESCE(ps.attempts,0)<(CASE WHEN t.max_attempts_set=1 THEN t.max_attempts ELSE ${policy.max_attempts ?? "NULL"} END))
      AND (po.total_attempt_cap IS NULL OR t.attempts_total<po.total_attempt_cap)
      AND NOT EXISTS(SELECT 1 FROM (${effectiveHeads(time, epoch)}) active WHERE active.task_uid=t.task_uid)
      AND (${mandatory.sql}) AND (${requested.sql})`;
    const scopeJoins = `JOIN pools po ON po.id=t.pool_id JOIN profiles p ON p.id=${sqlString(profile.id)} JOIN families f ON f.id=p.family_id`;
    // Filter placeholders are numbered first. Other values are fixed trusted literals or JSON binds.
    r.statements.push(
      stmt(
        db,
        `WITH fresh AS MATERIALIZED (
      SELECT t.task_uid,t.task_id,0 priority,NULL last_grant_at,COALESCE(ps.attempts,0) profile_attempts
      FROM tasks t INDEXED BY tasks_schedule ${scopeJoins} LEFT JOIN task_profile_state ps ON ps.task_uid=t.task_uid AND ps.profile_id=p.id
      WHERE COALESCE(ps.lifetime_attempts,0)=0 AND ${eligibility}
      ORDER BY t.task_id COLLATE BINARY,t.task_uid LIMIT ${grantLimit}
    ), retried AS MATERIALIZED (
      SELECT t.task_uid,t.task_id,1 priority,ps.last_grant_at,ps.attempts profile_attempts
      FROM task_profile_state ps INDEXED BY profile_schedule JOIN tasks t ON t.task_uid=ps.task_uid ${scopeJoins}
      WHERE ps.profile_id=${sqlString(profile.id)} AND ps.permanent_failure=0 AND ps.lifetime_attempts>0 AND ${eligibility}
      ORDER BY ps.last_grant_at,t.task_id COLLATE BINARY,t.task_uid LIMIT max(0,${grantLimit}-(SELECT COUNT(*) FROM fresh))
    ), chosen AS MATERIALIZED (SELECT * FROM fresh UNION ALL SELECT * FROM retried),
    candidates AS (SELECT t.*,ch.profile_attempts,${projection} returned_data,row_number() OVER(ORDER BY ch.priority,ch.last_grant_at,ch.task_id COLLATE BINARY,ch.task_uid)-1 ordinal FROM chosen ch JOIN tasks t ON t.task_uid=ch.task_uid),
    sized AS (SELECT *,sum(length(CAST(returned_data AS BLOB))+length(CAST(tags_json AS BLOB))+1200) OVER(ORDER BY ordinal) response_size FROM candidates)
    UPDATE requests SET metadata_json=json_set(metadata_json,'$.selection',json(COALESCE((SELECT json_group_array(json_object('ordinal',ordinal,'task_uid',task_uid,'attempt_id',json_extract(seed.value,'$.id'),'token',json_extract(seed.value,'$.token'),'returned_data',json(returned_data),'profile_attempts',profile_attempts+1,'attempts_total',attempts_total+1,'snapshot_id',task_uid||':'||input_revision,'initial_expiry',${time}+${duration * 1000},'fits',response_size<=${LIMITS.responseBytes - 2048})) FROM sized JOIN json_each(?${extra + 1}) seed ON CAST(seed.key AS INTEGER)=sized.ordinal),'[]'))) WHERE uid=${sqlString(r.uid)}`,
        ...mandatory.params,
        ...requested.params,
        json(seeds),
      ),
    );
    r.statements.push(
      stmt(
        db,
        `INSERT INTO request_items(request_uid,ordinal,item_id,task_uid,attempt_id,status,value_json) SELECT ?,json_extract(value,'$.ordinal'),CAST(json_extract(value,'$.ordinal') AS TEXT),json_extract(value,'$.task_uid'),json_extract(value,'$.attempt_id'),'selected',value FROM requests q,json_each(q.metadata_json,'$.selection') WHERE q.uid=? AND json_extract(value,'$.fits')=1`,
        r.uid,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        db,
        `UPDATE requests SET metadata_json=json_remove(json_set(metadata_json,'$.response_size_limited',EXISTS(SELECT 1 FROM json_each(metadata_json,'$.selection') WHERE json_extract(value,'$.fits')=0),'$.eligible_count',json_array_length(metadata_json,'$.selection')),'$.selection') WHERE uid=?`,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        db,
        `INSERT INTO input_snapshots(id,task_uid,input_revision,input_hash,parameters_json,tags_json,schema_version)
      SELECT t.task_uid||':'||t.input_revision,t.task_uid,t.input_revision,t.input_hash,t.parameters_json,t.tags_json,t.input_contract_revision FROM tasks t JOIN request_items i ON i.task_uid=t.task_uid WHERE i.request_uid=? ON CONFLICT(task_uid,input_revision,input_hash) DO NOTHING`,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        db,
        `UPDATE attempts SET revoked_at=${time},revoke_reason='superseded' WHERE id IN (SELECT t.latest_attempt_id FROM tasks t JOIN request_items i ON i.task_uid=t.task_uid WHERE i.request_uid=?) AND outcome IS NULL AND revoked_at IS NULL`,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        db,
        `INSERT INTO attempts(id,task_uid,profile_id,family_id,pool_id,task_id,identity_json,attempt_sequence,lease_generation,instance_epoch,worker_id,issuing_key_id,lease_token,issued_at,expires_at,maximum_expires_at,input_snapshot_id,input_revision,input_hash,contract_json,returned_data_json,attempts,attempts_total)
      SELECT i.attempt_id,t.task_uid,?,?,?,t.task_id,?,t.attempt_sequence+1,t.lease_generation+1,?,?,?,json_extract(i.value_json,'$.token'),${time},json_extract(i.value_json,'$.initial_expiry'),${time}+?,json_extract(i.value_json,'$.snapshot_id'),t.input_revision,t.input_hash,?,json_extract(i.value_json,'$.returned_data'),json_extract(i.value_json,'$.profile_attempts'),t.attempts_total+1 FROM request_items i JOIN tasks t ON t.task_uid=i.task_uid WHERE i.request_uid=?`,
        profile.id,
        family.id,
        pool.id,
        json({
          family: family.name,
          profile: profile.name,
          pool: pool.name,
          key_label: c.actor.label,
        }),
        c.env.INSTANCE_EPOCH,
        body.worker_id,
        c.actor.id,
        policy.max_lifetime_seconds * 1000,
        contract,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        db,
        `UPDATE tasks SET latest_attempt_id=(SELECT attempt_id FROM request_items WHERE request_uid=? AND task_uid=tasks.task_uid),lease_generation=lease_generation+1,attempt_sequence=attempt_sequence+1,lifetime_attempts=lifetime_attempts+1,attempts_total=attempts_total+1,state_revision=state_revision+1,updated_at=${time} WHERE task_uid IN(SELECT task_uid FROM request_items WHERE request_uid=?)`,
        r.uid,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        db,
        `INSERT INTO task_profile_state(task_uid,profile_id,attempts,lifetime_attempts,last_grant_at) SELECT task_uid,?,1,1,${time} FROM request_items WHERE request_uid=? ON CONFLICT(task_uid,profile_id) DO UPDATE SET attempts=attempts+1,lifetime_attempts=lifetime_attempts+1,last_grant_at=excluded.last_grant_at`,
        profile.id,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        db,
        `INSERT INTO lease_heads(task_uid,attempt_id,pool_id,profile_id,family_id,worker_id,issuing_key_id,instance_epoch,lease_generation,expires_at) SELECT a.task_uid,a.id,a.pool_id,a.profile_id,a.family_id,a.worker_id,a.issuing_key_id,a.instance_epoch,a.lease_generation,a.expires_at FROM attempts a JOIN request_items i ON i.attempt_id=a.id WHERE i.request_uid=? ON CONFLICT(task_uid) DO UPDATE SET attempt_id=excluded.attempt_id,pool_id=excluded.pool_id,profile_id=excluded.profile_id,family_id=excluded.family_id,worker_id=excluded.worker_id,issuing_key_id=excluded.issuing_key_id,instance_epoch=excluded.instance_epoch,lease_generation=excluded.lease_generation,expires_at=excluded.expires_at`,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        db,
        `INSERT INTO attempt_events(id,attempt_id,kind,timestamp,request_id,metadata_json) SELECT attempt_id||':grant',attempt_id,'grant',${time},?,'{}' FROM request_items WHERE request_uid=?`,
        body.request_id,
        r.uid,
      ),
    );
    // Store the initial DTO as immutable response JSON. Renewals never alter it.
    r.statements.push(
      stmt(
        db,
        `UPDATE request_items SET status='applied',response_json=(SELECT json_object('task_id',a.task_id,'attempt_id',a.id,'lease_token',a.lease_token,'lease_generation',a.lease_generation,'instance_epoch',a.instance_epoch,'issued_at',a.issued_at,'expires_at',a.expires_at,'maximum_expires_at',a.maximum_expires_at,'input_revision',a.input_revision,'attempts',a.attempts,'attempts_total',a.attempts_total,'tags',json(s.tags_json),'data',json(a.returned_data_json)) FROM attempts a JOIN input_snapshots s ON s.id=a.input_snapshot_id WHERE a.id=request_items.attempt_id) WHERE request_uid=?`,
        r.uid,
      ),
    );
  }
  const result = await commitReceipt(r),
    meta = JSON.parse(result.receipt.metadata_json),
    tasks = result.items.map((i) => {
      const v = JSON.parse(i.response_json);
      return {
        ...v,
        issued_at: iso(v.issued_at),
        expires_at: iso(v.expires_at),
        maximum_expires_at: iso(v.maximum_expires_at),
      };
    });
  const reasons: string[] = [];
  if (meta.draining) reasons.push("DRAINING");
  if (meta.caps.request < body.count) reasons.push("REQUEST_CAP");
  for (const [key, reason] of Object.entries({
    worker_profile: "WORKER_PROFILE_CAP",
    profile: "PROFILE_CAP",
    pool: "POOL_CAP",
    worker_family: "WORKER_FAMILY_CAP",
    family: "FAMILY_CAP",
  }))
    if (
      meta.caps[key] !== null &&
      meta.caps[key] - meta.usage[key] < Math.min(body.count, meta.caps.request)
    )
      reasons.push(reason);
  if (meta.response_size_limited) reasons.push("RESPONSE_SIZE");
  if (meta.eligible_count < meta.grant_limit) reasons.push("ELIGIBLE_TASKS");
  return {
    canonical_profile_id: meta.canonical_profile_id,
    requested_count: meta.requested_count,
    granted_count: tasks.length,
    limiting_reasons: reasons,
    tasks,
    ...(!tasks.length ? { retry_after_seconds: 30 } : {}),
  };
}

export async function reportOrRenew(c: Context, renew = false): Promise<unknown> {
  const body = validate(batchSchema, c.body);
  assert(c.actor.kind === "key", "FORBIDDEN", "A family key is required.", 403);
  if (renew)
    assert(c.actor.status === "active", "KEY_REVOKED", "An active key is required to renew.", 403);
  const { profile, policy } = await resolveProfile(c.env, c.actor, body.pool, body.request_id);
  const r = await beginReceipt(c.env, c.actor, renew ? "renew" : "report", profile.id, body, {
    keyActive: renew,
    retention: (policy.max_lifetime_seconds + 86400) * 1000,
  });
  if (!r.existing) {
    const ids = body.items.map((x) => (x as any)?.attempt_id).filter((x) => typeof x === "string");
    const attempts = await all(
      c.env.DB,
      "SELECT * FROM attempts WHERE id IN(SELECT value FROM json_each(?)) AND issuing_key_id=?",
      json(ids),
      c.actor.id,
    );
    const seen = new Map<string, number>();
    for (const raw of body.items) {
      const v = raw as any;
      for (const k of ["attempt_id", "task_id", "item_id"])
        if (typeof v?.[k] === "string") {
          const key = k + ":" + v[k];
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
    }
    const staged: Row[] = [];
    for (let ordinal = 0; ordinal < body.items.length; ordinal++) {
      const raw = body.items[ordinal] as any,
        p = (renew ? renewItemSchema : reportItemSchema).safeParse(raw);
      let error: string | null = null,
        message: string | undefined;
      let value: Row = {};
      if (!p.success) {
        error = "INVALID_VALUE";
        message = p.error.issues.map((e) => e.message).join("; ");
      } else {
        value = p.data as Row;
        if (
          ["attempt_id", "task_id", "item_id"].some((k) => (seen.get(k + ":" + value[k]) ?? 0) > 1)
        ) {
          error = "BAD_REQUEST";
          message = "Duplicate task, attempt, or item in this batch.";
        }
        const a = attempts.find((a) => a.id === value.attempt_id);
        if (!renew && !error)
          try {
            if (value.outcome === "success") {
              assert(
                Object.hasOwn(value, "result"),
                "INVALID_RESULT",
                "A success result must be supplied.",
              );
              if (a) {
                const contract = JSON.parse(a.contract_json);
                value.mapped = mapResult(value.result, contract.fields, contract.required_result);
              }
            }
            if (value.details !== undefined)
              assert(
                json(value.details).length <= LIMITS.resultBytes,
                "PAYLOAD_TOO_LARGE",
                "Failure details exceed 16 KiB.",
              );
            value.outcome_hash = await sha256(
              canonical({
                outcome: value.outcome,
                result: value.outcome === "success" ? value.result : null,
                message: value.message ?? null,
                details: value.details ?? null,
              }),
            );
          } catch (e) {
            error = e instanceof AppError ? e.code : "INVALID_RESULT";
            message = e instanceof Error ? e.message : "Invalid result.";
          }
      }
      staged.push({
        ordinal,
        item_id: typeof raw?.item_id === "string" ? raw.item_id : null,
        attempt_id: typeof raw?.attempt_id === "string" ? raw.attempt_id : null,
        value,
        error,
        message,
      });
    }
    const db = c.env.DB,
      time = `(SELECT accepted_at FROM requests WHERE uid=${sqlString(r.uid)})`;
    r.statements.push(
      stmt(
        db,
        `INSERT INTO request_items(request_uid,ordinal,item_id,attempt_id,value_json,error_code) SELECT ?,json_extract(value,'$.ordinal'),json_extract(value,'$.item_id'),json_extract(value,'$.attempt_id'),json_extract(value,'$.value'),json_extract(value,'$.error') FROM json_each(?)`,
        r.uid,
        json(staged),
      ),
    );
    r.statements.push(
      stmt(
        db,
        `UPDATE request_items SET task_uid=(SELECT task_uid FROM attempts WHERE id=request_items.attempt_id),error_code=COALESCE(error_code,(SELECT CASE
      WHEN a.id IS NULL OR a.issuing_key_id!=? OR a.worker_id!=? OR a.profile_id!=? OR a.task_id!=json_extract(i.value_json,'$.task_id') OR a.lease_token!=json_extract(i.value_json,'$.lease_token') THEN 'STALE_LEASE'
      WHEN a.instance_epoch!=? OR a.instance_epoch!=json_extract(i.value_json,'$.instance_epoch') THEN 'INSTANCE_CHANGED'
      WHEN k.status='hard_revoked' OR (k.status='soft_revoked' AND (${renew ? 1 : 0}=1 OR a.expires_at<=${time})) THEN 'KEY_REVOKED'
      ${!renew ? "WHEN a.outcome IS NOT NULL THEN CASE WHEN a.outcome_hash=json_extract(i.value_json,'$.outcome_hash') THEN NULL ELSE 'RESULT_CONFLICT' END" : ""}
      WHEN a.input_revision!=t.input_revision OR a.input_hash!=t.input_hash THEN 'INPUT_CHANGED'
      WHEN EXISTS(SELECT 1 FROM pools WHERE id=a.pool_id AND migration_status!='ready') THEN 'SCHEMA_MIGRATING'
      WHEN a.revoked_at IS NOT NULL OR a.id!=t.latest_attempt_id OR a.lease_generation!=t.lease_generation OR a.lease_generation!=json_extract(i.value_json,'$.lease_generation') THEN 'STALE_LEASE'
      WHEN a.outcome IS NOT NULL THEN 'STALE_LEASE'
      ${renew ? `WHEN a.expires_at<=${time} THEN 'LEASE_EXPIRED'` : ""}
      ELSE NULL END FROM request_items i LEFT JOIN attempts a ON a.id=i.attempt_id LEFT JOIN tasks t ON t.task_uid=a.task_uid LEFT JOIN api_keys k ON k.id=a.issuing_key_id WHERE i.request_uid=request_items.request_uid AND i.ordinal=request_items.ordinal)) WHERE request_uid=?`,
        c.actor.id,
        body.worker_id,
        profile.id,
        c.env.INSTANCE_EPOCH,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        db,
        `UPDATE request_items SET status=CASE WHEN error_code IS NOT NULL THEN 'rejected' ${!renew ? "WHEN (SELECT outcome FROM attempts WHERE id=request_items.attempt_id) IS NOT NULL THEN 'already_applied'" : ""} ELSE 'applied' END WHERE request_uid=?`,
        r.uid,
      ),
    );
    if (renew) {
      r.statements.push(
        stmt(
          db,
          `UPDATE attempts SET expires_at=max(expires_at,min(${time}+1000*json_extract((SELECT value_json FROM request_items WHERE request_uid=? AND attempt_id=attempts.id),'$.lease_seconds'),maximum_expires_at)) WHERE id IN(SELECT attempt_id FROM request_items WHERE request_uid=? AND status='applied')`,
          r.uid,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `UPDATE lease_heads SET expires_at=(SELECT expires_at FROM attempts WHERE id=lease_heads.attempt_id) WHERE attempt_id IN(SELECT attempt_id FROM request_items WHERE request_uid=? AND status='applied')`,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `UPDATE tasks SET state_revision=state_revision+1 WHERE task_uid IN(SELECT task_uid FROM request_items WHERE request_uid=? AND status='applied')`,
          r.uid,
        ),
      );
    } else {
      r.statements.push(
        stmt(
          db,
          `UPDATE attempts SET outcome=json_extract(i.value_json,'$.outcome'),outcome_hash=json_extract(i.value_json,'$.outcome_hash'),message=json_extract(i.value_json,'$.message'),details_json=CASE WHEN json_type(i.value_json,'$.details') IS NULL THEN NULL ELSE i.value_json -> '$.details' END,mapped_json=json_extract(i.value_json,'$.mapped'),runtime_seconds=json_extract(i.value_json,'$.runtime_seconds'),runtime_origin=json_extract(i.value_json,'$.runtime_origin'),finalized_at=${time},server_elapsed_seconds=(${time}-issued_at)/1000.0,late=CASE WHEN expires_at<=${time} THEN 1 ELSE 0 END FROM request_items i WHERE i.request_uid=? AND i.status='applied' AND attempts.id=i.attempt_id`,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `INSERT INTO attempt_results(attempt_id,raw_json) SELECT attempt_id,CASE json_type(value_json,'$.result') WHEN 'text' THEN json_quote(json_extract(value_json,'$.result')) WHEN 'null' THEN 'null' WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(json_extract(value_json,'$.result') AS TEXT) END FROM request_items WHERE request_uid=? AND status='applied' AND json_extract(value_json,'$.outcome')='success'`,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `UPDATE tasks SET state_revision=state_revision+1,updated_at=${time},completed_at=CASE WHEN a.outcome='success' THEN ${time} ELSE tasks.completed_at END,result_attempt_id=CASE WHEN a.outcome='success' THEN a.id ELSE tasks.result_attempt_id END,result_summary_json=CASE WHEN a.outcome='success' THEN a.mapped_json ELSE tasks.result_summary_json END,previous_result=CASE WHEN a.outcome='success' THEN 0 ELSE tasks.previous_result END FROM attempts a JOIN request_items i ON i.attempt_id=a.id WHERE i.request_uid=? AND i.status='applied' AND tasks.task_uid=a.task_uid`,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          `UPDATE task_profile_state SET permanent_failure=1,failure_message=a.message,failure_details_json=a.details_json FROM attempts a JOIN request_items i ON i.attempt_id=a.id WHERE i.request_uid=? AND i.status='applied' AND a.outcome='permanent_failure' AND task_profile_state.task_uid=a.task_uid AND task_profile_state.profile_id=a.profile_id`,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          db,
          "DELETE FROM lease_heads WHERE attempt_id IN(SELECT attempt_id FROM request_items WHERE request_uid=? AND status='applied')",
          r.uid,
        ),
      );
    }
    r.statements.push(
      stmt(
        db,
        `INSERT INTO attempt_events(id,attempt_id,kind,timestamp,request_id,metadata_json) SELECT request_uid||':'||ordinal,attempt_id,?,${time},?,json_object('late',(SELECT late FROM attempts WHERE id=attempt_id)) FROM request_items WHERE request_uid=? AND status='applied'`,
        renew ? "renew" : "finalize",
        body.request_id,
        r.uid,
      ),
    );
    r.statements.push(
      stmt(
        db,
        `UPDATE request_items SET response_json=json_object('item_id',item_id,'task_id',json_extract(value_json,'$.task_id'),'attempt_id',attempt_id,'status',status,'error_code',error_code,'outcome',(SELECT outcome FROM attempts WHERE id=attempt_id),'finalized_at',(SELECT finalized_at FROM attempts WHERE id=attempt_id),'late',(SELECT late FROM attempts WHERE id=attempt_id),'expires_at',(SELECT expires_at FROM attempts WHERE id=attempt_id),'maximum_expires_at',(SELECT maximum_expires_at FROM attempts WHERE id=attempt_id)) WHERE request_uid=?`,
        r.uid,
      ),
    );
  }
  const result = await commitReceipt(r);
  return {
    items: result.items.map((i) => {
      const v = JSON.parse(i.response_json);
      return {
        item_id: v.item_id,
        task_id: v.task_id,
        attempt_id: v.attempt_id,
        status: v.status,
        ...(v.error_code
          ? { error: { code: v.error_code, message: itemError(v.error_code) } }
          : renew
            ? {
                expires_at: iso(v.expires_at),
                maximum_expires_at: iso(v.maximum_expires_at),
                ...(v.expires_at === v.maximum_expires_at ? { reason: "MAXIMUM_LIFETIME" } : {}),
              }
            : {
                outcome: v.outcome,
                completed_at: iso(v.finalized_at),
                late: !!v.late,
              }),
      } as ItemResult;
    }),
  };
}
function itemError(code: string) {
  return (
    (
      {
        STALE_LEASE:
          "This lease is unknown, superseded, revoked, or does not belong to this worker.",
        INPUT_CHANGED: "Inputs changed after this lease was issued.",
        RESULT_CONFLICT: "A different outcome was already accepted.",
        LEASE_EXPIRED: "Expired leases cannot be renewed.",
        KEY_REVOKED: "The issuing key no longer permits this operation.",
        INVALID_RESULT: "The result does not satisfy the issued result contract.",
        INVALID_VALUE: "Correct the malformed item fields.",
        BAD_REQUEST: "The batch contains a duplicate task, attempt, or item.",
      } as Record<string, string>
    )[code] ?? code.replaceAll("_", " ").toLowerCase()
  );
}
export async function recover(c: Context) {
  const body = validate(recoverSchema, c.body);
  assert(c.actor.kind === "key", "FORBIDDEN", "A key is required.", 403);
  const { profile } = await resolveProfile(c.env, c.actor, body.pool);
  const { decodeCursor, encodeCursor } = await import("./pagination");
  const scope = {
    kind: "recover",
    key: c.actor.id,
    worker: body.worker_id,
    profile: profile.id,
  };
  const cursor = body.cursor ? await decodeCursor(c.env, body.cursor, scope) : null;
  const rows = await all(
    c.env.DB,
    `SELECT a.*,s.tags_json FROM (${effectiveHeads(DB_NOW, sqlString(c.env.INSTANCE_EPOCH))}) h JOIN attempts a ON a.id=h.attempt_id JOIN input_snapshots s ON s.id=a.input_snapshot_id WHERE a.issuing_key_id=? AND a.worker_id=? AND a.profile_id=? AND a.id>? ORDER BY a.id LIMIT 101`,
    c.actor.id,
    body.worker_id,
    profile.id,
    cursor?.last ?? "",
  );
  const page = rows.slice(0, 100);
  return {
    tasks: page.map((a) => attemptDto(a, true)),
    cursor: rows.length > 100 ? await encodeCursor(c.env, scope, { last: page.at(-1)!.id }) : null,
  };
}
