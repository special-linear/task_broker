import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const directory = resolve("artifacts/private/isolated-restore-" + randomUUID().slice(0, 8));
await mkdir(directory, { recursive: true });
await mkdir("artifacts/private/verification", { recursive: true });
const options = {
  modules: true,
  scriptPath: resolve("artifacts/private/restore-worker/index.js"),
  compatibilityDate: "2026-08-22",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: "isolated-restore" },
  d1Persist: directory,
  bindings: {
    ENVIRONMENT: "local",
    DEV_AUTH: "true",
    ADMIN_ORIGIN: "http://127.0.0.1:8787",
    BROKER_HOSTNAME: "127.0.0.1",
    OWNER_EMAILS: "local@example.test",
    INSTANCE_EPOCH: randomUUID(),
    APP_SIGNING_SECRET: randomUUID() + randomUUID(),
    LOG_QUERY_METRICS: "false",
  },
};
let mf = new Miniflare({
  ...convertV4MiniflareOptions(options),
  resourcePersistencePath: directory,
});
await (await mf.getD1Database("DB")).prepare("SELECT 1").run();
await mf.dispose();
const loader = `import pathlib,sqlite3,sys,json
root=pathlib.Path(sys.argv[1]).resolve();sql=pathlib.Path('artifacts/private/staging-consistent.sql').read_text(encoding='utf8')
files=[p for p in root.rglob('*.sqlite') if p.name!='metadata.sqlite' and 'd1' in p.parts];assert len(files)==1, len(files)
db=sqlite3.connect(files[0]);db.executescript('BEGIN IMMEDIATE;\\n'+sql+'\\nCOMMIT;')
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok';assert not db.execute('PRAGMA foreign_key_check').fetchall()
db.close();print('Restored native SQL into isolated local D1 storage.')`;
await new Promise((yes, no) => {
  const child = spawn("python", ["-c", loader, directory], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stdout.on("data", (b) => process.stdout.write(b));
  child.stderr.on("data", (b) => (errors += b));
  child.on("error", no);
  child.on("exit", (n) => (n ? no(new Error(errors)) : yes()));
});
mf = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: directory });
const meta = () => ({ request_id: randomUUID(), request_created_at: new Date().toISOString() });
async function call(path, body, key) {
  const response = await mf.dispatchFetch(
    "http://127.0.0.1:8787" + (key ? "/api/v1" : "/admin-api/v1") + path,
    {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(key
          ? { Authorization: `Bearer ${key}` }
          : { Origin: "http://127.0.0.1:8787", "X-Task-Broker": "1" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  return response.json();
}
try {
  const fixture = JSON.parse(await readFile("artifacts/private/performance-remote.json", "utf8")),
    db = await mf.getD1Database("DB");
  const old = await db
    .prepare("SELECT * FROM attempts WHERE family_id=? ORDER BY issued_at DESC LIMIT 1")
    .bind(fixture.family)
    .first();
  assert(old);
  const oldReport = {
    ...meta(),
    pool: fixture.slug,
    worker_id: old.worker_id,
    items: [
      {
        item_id: "old",
        task_id: old.task_id,
        attempt_id: old.id,
        lease_token: old.lease_token,
        lease_generation: old.lease_generation,
        instance_epoch: old.instance_epoch,
        outcome: "release",
      },
    ],
  };
  assert.equal(
    (await call("/claim", { ...meta(), pool: fixture.slug, worker_id: "restored" }, fixture.key))
      .error.code,
    "INSTANCE_CHANGED",
  );
  assert.equal((await call("/report", oldReport, fixture.key)).error.code, "INSTANCE_CHANGED");
  assert.equal(
    (await call("/epoch/activate", { ...meta(), reason: "Isolated restore epoch activation" })).ok,
    true,
  );
  const rejected = await call("/report", oldReport, fixture.key);
  assert.equal(rejected.error?.code ?? rejected.data?.items[0]?.error_code, "MAINTENANCE");
  const keys = (await call("/keys")).data.rows;
  for (const key of keys)
    if (key.status !== "hard_revoked")
      assert.equal(
        (await call(`/keys/${key.id}/hard-revoke`, { ...meta(), reason: "Restored key review" }))
          .ok,
        true,
      );
  assert.equal(
    (
      await call("/maintenance", {
        ...meta(),
        maintenance: false,
        reason: "Verified isolated restore",
      })
    ).ok,
    true,
  );
  assert.equal((await call("/report", oldReport, fixture.key)).error.code, "KEY_REVOKED");
  const issued = await call("/keys", {
    ...meta(),
    family_id: fixture.family,
    label: "Fresh isolated restore worker",
  });
  assert(issued.ok, JSON.stringify(issued));
  const claim = await call(
    "/claim",
    { ...meta(), pool: fixture.slug, worker_id: "fresh-restored", count: 1 },
    issued.data.key,
  );
  assert.equal(claim.data.tasks.length, 1);
  const t = claim.data.tasks[0];
  assert.equal(t.instance_epoch, options.bindings.INSTANCE_EPOCH);
  const report = await call(
    "/report",
    {
      ...meta(),
      pool: fixture.slug,
      worker_id: "fresh-restored",
      items: [
        {
          item_id: "fresh",
          task_id: t.task_id,
          attempt_id: t.attempt_id,
          lease_token: t.lease_token,
          lease_generation: t.lease_generation,
          instance_epoch: t.instance_epoch,
          outcome: "success",
          result: { answer: 42 },
        },
      ],
    },
    issued.data.key,
  );
  assert.equal(report.data.items[0].status, "applied");
  const counts = await db
    .prepare("SELECT (SELECT count(*) FROM tasks) tasks,(SELECT count(*) FROM attempts) attempts")
    .first();
  await writeFile(
    "artifacts/private/verification/isolated-restore.json",
    JSON.stringify(
      {
        completed: true,
        recorded_at: new Date().toISOString(),
        native_backup: true,
        checks: [
          "native SQL restored into separate local D1",
          "SQLite integrity and foreign keys valid",
          "new external epoch enforced before opening",
          "restored keys quarantined",
          "old authority rejected",
          "fresh claim and report succeeded",
        ],
        counts,
      },
      null,
      2,
    ),
  );
  console.log("PASS isolated native restore, epoch fencing, key quarantine and fresh work.");
} finally {
  await mf.dispose();
}
