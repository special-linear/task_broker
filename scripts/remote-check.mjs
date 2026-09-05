import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { accessToken } from "./access-session.mjs";
import { loadWranglerConfig } from "./wrangler-config.ts";

const config = (await loadWranglerConfig()).env.staging;
const origin = process.env.STAGING_ORIGIN ?? config.vars.ADMIN_ORIGIN;
const token = await accessToken(config.vars.ACCESS_AUDIENCE);
const timings = [],
  checks = [];
const meta = () => ({ request_id: randomUUID(), request_created_at: new Date().toISOString() });
async function call(path, body, key, method) {
  const started = performance.now();
  const response = await fetch(origin + (key ? "/api/v1" : "/admin-api/v1") + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      ...(key
        ? { Authorization: `Bearer ${key}` }
        : { Cookie: `CF_Authorization=${token}`, Origin: origin, "X-Task-Broker": "1" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  timings.push({
    path,
    ms: Math.round((performance.now() - started) * 100) / 100,
    status: response.status,
    server_timing: response.headers.get("server-timing"),
  });
  const content = await response.text();
  assert(
    response.headers.get("content-type")?.includes("application/json"),
    `${path}: HTTP ${response.status}, unexpected response type`,
  );
  return { ...JSON.parse(content), http_status: response.status };
}
const admin = (p, b, m) => call(p, b, undefined, m),
  compute = (key, p, b) => call(p, b, key);
const good = (r) => {
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return r.data;
};
const check = (id) => {
  checks.push(id);
  console.log(`PASS ${id}`);
};
const identity = (t) => ({
  item_id: t.task_id,
  task_id: t.task_id,
  attempt_id: t.attempt_id,
  lease_token: t.lease_token,
  lease_generation: t.lease_generation,
  instance_epoch: t.instance_epoch,
});
await mkdir("artifacts/private", { recursive: true });
await mkdir("artifacts/private/verification", { recursive: true });
const me = good(await admin("/me"));
if (me.installation.setup_status === "closed") good(await admin("/bootstrap", meta()));
const slug = `verification-${randomUUID().slice(0, 8)}`;
const family = good(
  await admin("/families", {
    ...meta(),
    slug,
    name: `Staging verification ${new Date().toISOString()}`,
  }),
);
const pool = good(
  await admin("/pools", {
    ...meta(),
    family_id: family.id,
    name: "Disposable staging checks",
    fields: [
      { key: "n", label: "n", type: "integer", required: true },
      { key: "answer", label: "Answer", type: "integer", kind: "result", pointer: "/answer" },
    ],
  }),
);
const issued = good(
    await admin("/keys", {
      ...meta(),
      family_id: family.id,
      label: "Disposable remote verification",
    }),
  ),
  key = issued.key;
await writeFile(
  "artifacts/private/remote-fixture.json",
  JSON.stringify({
    origin,
    slug,
    family: family.id,
    pool: pool.id,
    profile: pool.profile_id,
    key,
    key_id: issued.id,
  }),
  { mode: 0o600 },
);
const importOp = good(
  await admin("/imports/preview", { ...meta(), pool_id: pool.id, mode: "add", total: 60 }),
);
for (let start = 0; start < 60; start += 50)
  good(
    await admin(`/imports/${importOp.operation_id}/preview-chunks`, {
      ...meta(),
      start,
      rows: Array.from({ length: Math.min(50, 60 - start) }, (_, j) => ({
        task_id: `remote-${String(start + j).padStart(3, "0")}`,
        data: { n: start + j },
      })),
    }),
  );
for (let i = 0; i < 2; i++)
  good(await admin(`/imports/${importOp.operation_id}/chunks`, { ...meta(), limit: 50 }));
check("REMOTE-SETUP protected admin create/import");
const same = { ...meta(), pool: slug, worker_id: "same", count: 2 };
const duplicates = await Promise.all(Array.from({ length: 5 }, () => compute(key, "/claim", same)));
const first = good(duplicates[0]);
for (const d of duplicates) assert.deepEqual(good(d), first);
check("DB-02/DB-06 identical concurrent requests and discarded-response replay");
assert.equal(
  (await compute(key, "/claim", { ...same, count: 3 })).error.code,
  "IDEMPOTENCY_CONFLICT",
);
check("DB-03 cross-body conflict");
const claims = await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    compute(key, "/claim", { ...meta(), pool: slug, worker_id: `burst-${i}`, count: 1 }),
  ),
);
const tasks = claims.flatMap((r, i) => good(r).tasks.map((t) => ({ ...t, worker: `burst-${i}` })));
assert.equal(tasks.length, 20);
assert.equal(new Set([...tasks, ...first.tasks].map((t) => t.task_id)).size, 22);
check("DB-01 20 deployed concurrent clients, unique active grants");
const t = tasks[0],
  report = {
    ...meta(),
    pool: slug,
    worker_id: t.worker,
    items: [{ ...identity(t), outcome: "success", result: { answer: 7 } }, { bad: true }],
  };
const reported = good(await compute(key, "/report", report));
assert.deepEqual(
  reported.items.map((x) => x.status),
  ["applied", "rejected"],
);
assert.deepEqual(good(await compute(key, "/report", report)).items, reported.items);
check("LEASE-09 mixed report and lost-response replay");
const recovered = good(await compute(key, "/recover", { pool: slug, worker_id: tasks[1].worker }));
assert.equal(recovered.tasks[0].attempt_id, tasks[1].attempt_id);
check("LEASE-10 recovery");
const rowPage = good(await admin(`/pools/${pool.id}/tasks`));
const completed = rowPage.rows.find((r) => r.task_id === t.task_id);
assert.equal(completed.status, "completed");
assert.deepEqual(completed.result, { answer: 7 });
const history = good(await admin(`/tasks/${completed.task_uid}/attempts`));
assert.equal(history.attempts.length, 1);
assert(!JSON.stringify(history).includes(t.lease_token));
check("LEASE-01 persistent result and immutable history");
const leaseRow = rowPage.rows.find((r) => r.task_id === tasks[1].task_id);
const preview = good(
  await admin("/tasks/bulk/preview", {
    ...meta(),
    pool_id: pool.id,
    selection: { ids: [leaseRow.task_uid] },
    action: { kind: "reset", mode: "full", scope: "all", revoke: true },
  }),
);
const racingReport = {
  ...meta(),
  pool: slug,
  worker_id: tasks[1].worker,
  items: [{ ...identity(tasks[1]), outcome: "success", result: { answer: 9 } }],
};
const [reset, raceReport] = await Promise.all([
  admin(`/operations/${preview.operation_id}/apply`, { ...meta(), limit: 50 }),
  compute(key, "/report", racingReport),
]);
const resetResult = good(reset).items[0],
  reportResult = good(raceReport).items[0];
assert(resetResult.status === "rejected" || reportResult.status === "rejected");
check("LEASE-06 reset/report serialization");
const editable = rowPage.rows.find((r) => r.status === "pending");
const [edit, claimRace] = await Promise.all([
  admin(
    `/tasks/${editable.task_uid}`,
    {
      ...meta(),
      expected_edit_revision: editable.edit_revision,
      expected_input_revision: editable.input_revision,
      patch: { data: { n: 10000 } },
    },
    "PATCH",
  ),
  compute(key, "/claim", {
    ...meta(),
    pool: slug,
    worker_id: "edit-race",
    filter: `task_id = "${editable.task_id}"`,
  }),
]);
const editGrant = good(claimRace).tasks[0];
assert(edit.ok ? editGrant.data.n === 10000 : edit.error.code === "TASK_LEASED");
check("UI-05/DB-05 edit/claim serialization and rejected edit rollback");
const exportOp = good(await admin("/exports", { ...meta(), pool_id: pool.id, selection: {} }));
const exported = good(await admin(`/exports/${exportOp.operation_id}/pages`));
assert.equal(exported.rows.length, 60);
check("UI-10 frozen export contains all 60 rows");
for (const path of [
  "/admin/",
  "/admin/assets/missing.js",
  "/admin-api/v1/me",
  "/admin-api/v1/pools",
]) {
  const response = await fetch(origin + path, {
    redirect: "manual",
    headers: {
      "Cf-Access-Jwt-Assertion": "forged",
      "Cf-Access-Authenticated-User-Email": config.vars.OWNER_EMAILS,
    },
  });
  assert([302, 401, 403].includes(response.status));
}
const unauth = await fetch(origin + "/api/v1/claim", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
  redirect: "manual",
});
assert.equal(unauth.status, 401);
assert(!unauth.headers.has("location"));
check("AUTH-01/02 edge coverage, forged identity, compute path independence");
good(
  await admin(`/keys/${issued.id}/hard-revoke`, {
    ...meta(),
    reason: "Remote verification complete",
  }),
);
assert.equal((await compute(key, "/claim", same)).error.code, "KEY_REVOKED");
check("AUTH-05 hard revocation blocks receipt replay");
const currentPool = good(await admin(`/pools/${pool.id}`));
good(
  await admin(
    `/pools/${pool.id}`,
    { ...meta(), expected_revision: currentPool.config_revision, patch: { archived: true } },
    "PATCH",
  ),
);
const sorted = timings.map((t) => t.ms).sort((a, b) => a - b),
  percentile = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
const evidence = {
  timestamp: new Date().toISOString(),
  origin,
  checks,
  requests: timings.length,
  latency_ms: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  timings,
  limitations: [
    "Smoke and burst results; separate 10,000-row and steady/idle performance gates still required.",
    "Worker CPU requires Cloudflare metrics; HTTP wall time is not CPU.",
  ],
  fixture: { family: family.id, pool: pool.id, archived: true, key_revoked: true },
};
await writeFile(
  "artifacts/private/verification/remote-smoke.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    checks: checks.length,
    requests: timings.length,
    latency_ms: evidence.latency_ms,
  }),
);
