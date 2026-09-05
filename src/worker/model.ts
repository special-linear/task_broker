import { assert, effectivePolicy, iso, type Field } from "../shared/core";
import { fieldResolver, type ResolvedField } from "../shared/filter";
import { all, one, DB_NOW, effectiveHeads } from "./db";
import type { Actor, Env, Row } from "./types";
export function fieldFromRow(r: Row): Field {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type,
    kind: r.kind,
    required: !!r.required,
    nullable: !!r.nullable,
    ...(r.default_json === null ? {} : { default: JSON.parse(r.default_json) }),
    pointer: r.pointer ?? undefined,
    position: r.position,
    active: !!r.active,
  };
}
export const fieldsFor = async (env: Env, pool: string) =>
  (await all(env.DB, "SELECT * FROM pool_fields WHERE pool_id=? ORDER BY position,id", pool)).map(
    fieldFromRow,
  );
export async function resolveProfile(env: Env, actor: Actor, path: string, requestId?: string) {
  const route = path.toLowerCase();
  const [familySlug, profileSlug, ...rest] = route.split("/");
  assert(!rest.length, "UNKNOWN_POOL", "Unknown pool route.", 404);
  // One indexed read loads the route and immutable configuration snapshot. The
  // mutation batch rechecks every revision before using this prepared contract.
  const record = await one(
    env.DB,
    `WITH candidates AS (
    SELECT scope id,0 priority FROM requests WHERE actor=? AND request_id=? AND original_route=?
    UNION ALL SELECT profile_id,1 FROM profile_aliases WHERE route=?
    UNION ALL SELECT default_profile_id,2 FROM families WHERE slug=? AND ? IS NULL
    UNION ALL SELECT p.id,2 FROM profiles p JOIN families f ON f.id=p.family_id WHERE f.slug=? AND p.slug=?
  ), selected AS (SELECT id FROM candidates ORDER BY priority LIMIT 1)
  SELECT p.*,
    json_object('id',po.id,'name',po.name,'enabled',po.enabled,'archived_at',po.archived_at,'active_cap',po.active_cap,'total_attempt_cap',po.total_attempt_cap,'migration_status',po.migration_status,'schema_version',po.schema_version,'required_result',po.required_result,'config_revision',po.config_revision) resolved_pool,
    json_object('id',f.id,'name',f.name,'enabled',f.enabled,'archived_at',f.archived_at,'policy_json',f.policy_json,'config_revision',f.config_revision) resolved_family,
    json_object('id',i.id,'config_revision',i.config_revision,'active_epoch',i.active_epoch,'maintenance',i.maintenance,'setup_status',i.setup_status,'defaults_json',i.defaults_json) resolved_installation,
    sv.fields_json resolved_fields
  FROM selected x JOIN profiles p ON p.id=x.id JOIN pools po ON po.id=p.pool_id JOIN families f ON f.id=p.family_id JOIN installation i ON i.id=1 JOIN schema_versions sv ON sv.pool_id=po.id AND sv.version=po.schema_version`,
    `${actor.kind}:${actor.id}`,
    requestId ?? null,
    path,
    route,
    familySlug,
    profileSlug ?? null,
    familySlug,
    profileSlug ?? null,
  );
  assert(record, "UNKNOWN_POOL", "Unknown pool route.", 404);
  assert(
    actor.kind === "admin" || actor.family_id === record.family_id,
    "FORBIDDEN",
    "This key does not authorize that family.",
    403,
  );
  const { resolved_pool, resolved_family, resolved_installation, resolved_fields, ...profile } =
    record;
  const pool = JSON.parse(resolved_pool),
    family = JSON.parse(resolved_family),
    installation = JSON.parse(resolved_installation),
    fields: Field[] = JSON.parse(resolved_fields);
  const familyPolicy = effectivePolicy(
    JSON.parse(installation.defaults_json),
    JSON.parse(family.policy_json),
  );
  const policy = {
    ...effectivePolicy(
      JSON.parse(installation.defaults_json),
      JSON.parse(family.policy_json),
      JSON.parse(profile.policy_json),
    ),
  };
  // Family-wide capacities cannot differ by the profile through which work arrives.
  policy.family_cap = familyPolicy.family_cap;
  policy.worker_family_cap = familyPolicy.worker_family_cap;
  return { profile, pool, family, installation, fields, policy };
}
export function globalStatus(time: string, epoch: string) {
  return `CASE WHEN t.deleted_at IS NOT NULL THEN 'deleted' WHEN t.completed_at IS NOT NULL THEN 'completed' WHEN EXISTS(SELECT 1 FROM (${effectiveHeads(time, epoch)}) eh WHERE eh.task_uid=t.task_uid) THEN 'leased' WHEN t.enabled=0 OR po.enabled=0 OR po.archived_at IS NOT NULL THEN 'disabled' WHEN po.total_attempt_cap IS NOT NULL AND t.attempts_total>=po.total_attempt_cap THEN 'exhausted' ELSE 'pending' END`;
}
export function resolverFor(
  fields: Field[],
  profileId: string | null,
  time = DB_NOW,
  epoch = "(SELECT active_epoch FROM installation WHERE id=1)",
  allowlist?: string[],
) {
  const total = globalStatus(time, epoch);
  const attemptLimit = `CASE WHEN t.max_attempts_set=1 THEN t.max_attempts WHEN json_type(p.policy_json,'$.max_attempts') IS NOT NULL THEN json_extract(p.policy_json,'$.max_attempts') WHEN json_type(f.policy_json,'$.max_attempts') IS NOT NULL THEN json_extract(f.policy_json,'$.max_attempts') WHEN json_type((SELECT defaults_json FROM installation WHERE id=1),'$.max_attempts') IS NOT NULL THEN json_extract((SELECT defaults_json FROM installation WHERE id=1),'$.max_attempts') ELSE 10 END`;
  const status = profileId
    ? `CASE WHEN (${total})!='pending' THEN (${total}) WHEN p.enabled=0 OR f.enabled=0 THEN 'disabled' WHEN COALESCE(ps.permanent_failure,0)=1 THEN 'failed' WHEN (${attemptLimit})<=COALESCE(ps.attempts,0) THEN 'exhausted' ELSE 'pending' END`
    : total;
  const system: Record<string, ResolvedField> = {};
  for (const [key, type, expression] of [
    ["task_id", "string", "t.task_id"],
    ["enabled", "boolean", "t.enabled"],
    ["admin_note", "string", "t.admin_note"],
    ["attempts_total", "integer", "t.attempts_total"],
    ["attempts", "integer", profileId ? "COALESCE(ps.attempts,0)" : "t.attempts_total"],
    ["status_total", "string", total],
    ["status", "string", status],
  ] as const)
    system[key] = { key, type, expression };
  return fieldResolver(fields, system, allowlist);
}
export function taskDto(r: Row) {
  return {
    task_uid: r.task_uid,
    pool_id: r.pool_id,
    migration_status: r.migration_status ?? "ready",
    task_id: r.task_id,
    data: JSON.parse(r.parameters_json),
    tags: JSON.parse(r.tags_json),
    enabled: !!r.enabled,
    admin_note: r.admin_note,
    max_attempts: r.max_attempts_set ? r.max_attempts : "inherit",
    edit_revision: r.edit_revision,
    input_revision: r.input_revision,
    state_revision: r.state_revision,
    lease_generation: r.lease_generation,
    attempt_sequence: r.attempt_sequence,
    attempts: r.profile_attempts ?? r.attempts_total,
    attempts_total: r.attempts_total,
    status: r.status ?? "pending",
    status_total: r.status_total ?? r.status ?? "pending",
    expires_at: iso(r.expires_at),
    completed_at: iso(r.completed_at),
    result: r.result_summary_json ? JSON.parse(r.result_summary_json) : null,
    previous_result: !!r.previous_result,
    deleted_at: iso(r.deleted_at),
  };
}
export function attemptDto(a: Row, current = false) {
  return {
    task_id: a.task_id,
    attempt_id: a.id,
    lease_token: a.lease_token,
    lease_generation: a.lease_generation,
    instance_epoch: a.instance_epoch,
    issued_at: iso(a.issued_at),
    expires_at: iso(a.expires_at),
    maximum_expires_at: iso(a.maximum_expires_at),
    input_revision: a.input_revision,
    attempts: a.attempts,
    attempts_total: a.attempts_total,
    tags: JSON.parse(a.tags_json),
    data: JSON.parse(a.returned_data_json),
    ...(current ? { recovered: true } : {}),
  };
}
