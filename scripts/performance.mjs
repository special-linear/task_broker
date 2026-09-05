import { writeFile, mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { origin, meta, admin, compute, measurements, summary } from "./verification-api.mjs";
const size = Number(process.env.PERF_TASKS ?? 10000),
  steadyCalls = Number(process.env.PERF_STEADY_CALLS ?? 60),
  local = origin.startsWith("http://127.0.0.1");
await mkdir("artifacts/private/verification", { recursive: true });
await mkdir("artifacts/private", { recursive: true });
const evidence = {
  started_at: new Date().toISOString(),
  origin,
  requested_tasks: size,
  stages: {},
  limitations: [],
  measurements,
};
const label = process.env.PERF_RUN_LABEL ?? "";
assert(/^[a-z0-9-]*$/.test(label));
const suffix = label ? `-${label}` : "";
const privateFile = `artifacts/private/performance-${local ? "local" : "remote"}${suffix}.json`;
let fixture;
try {
  const ready = await admin("/me");
  if (ready.installation.setup_status === "closed") await admin("/bootstrap", meta());
  if (process.argv.includes("--resume")) fixture = JSON.parse(await readFile(privateFile, "utf8"));
  else {
    const slug = `perf-${randomUUID().slice(0, 8)}`,
      family = await admin("/families", { ...meta(), slug, name: `Performance ${size} tasks` }),
      pool = await admin("/pools", {
        ...meta(),
        family_id: family.id,
        name: `Performance fixture ${slug}`,
        fields: [
          { key: "n", label: "n", type: "integer", required: true },
          { key: "label", label: "Label", type: "string" },
          { key: "payload", label: "Payload", type: "json" },
          { key: "answer", label: "Answer", type: "integer", kind: "result", pointer: "/answer" },
        ],
      }),
      key = await admin("/keys", {
        ...meta(),
        family_id: family.id,
        label: "Performance verification",
      }),
      op = await admin("/imports/preview", {
        ...meta(),
        pool_id: pool.id,
        mode: "add",
        total: size,
      });
    const other = await admin("/families", {
      ...meta(),
      slug: `${slug}-shared`,
      name: "Second performance family",
    });
    await admin("/profiles", {
      ...meta(),
      family_id: other.id,
      pool_id: pool.id,
      slug: "shared",
      name: "Shared performance profile",
    });
    fixture = {
      origin,
      slug,
      family: family.id,
      pool: pool.id,
      profile: pool.profile_id,
      key: key.key,
      key_id: key.id,
      operation_id: op.operation_id,
      previewed: 0,
    };
    await writeFile(privateFile, JSON.stringify(fixture), { mode: 0o600 });
  }
  const importStart = measurements.length;
  for (let start = fixture.previewed; start < size; start += 50) {
    const body = {
      ...meta(),
      start,
      rows: Array.from({ length: Math.min(50, size - start) }, (_, j) => ({
        task_id: `task-${String(start + j).padStart(6, "0")}`,
        data: {
          n: start + j,
          label: `Sample ${start + j} — Ω`,
          payload: {
            seed: String(9007199254740993n + BigInt(start + j)),
            matrix: [1, 2, 3, 4],
            description: "Realistic immutable input ".repeat(12),
          },
        },
      })),
    };
    await admin(`/imports/${fixture.operation_id}/preview-chunks`, body);
    if (start === 0) await admin(`/imports/${fixture.operation_id}/preview-chunks`, body);
    fixture.previewed = start + body.rows.length;
    await writeFile(privateFile, JSON.stringify(fixture), { mode: 0o600 });
    if (fixture.previewed % 1000 === 0) console.log(`Previewed ${fixture.previewed}/${size}`);
  }
  let op = await admin(`/operations/${fixture.operation_id}`);
  while (op.processed < size) {
    const body = { ...meta(), limit: 50 },
      result = await admin(`/imports/${fixture.operation_id}/chunks`, body);
    assert(result.items.every((i) => i.status === "applied"));
    if (op.processed === 0)
      assert.deepEqual(
        (await admin(`/imports/${fixture.operation_id}/chunks`, body)).items,
        result.items,
      );
    op = await admin(`/operations/${fixture.operation_id}`);
    if (op.processed % 1000 === 0) console.log(`Imported ${op.processed}/${size}`);
  }
  evidence.stages.import = summary(measurements.slice(importStart));
  const exportStart = measurements.length,
    exportOp = await admin("/exports", {
      ...meta(),
      pool_id: fixture.pool,
      selection: { filter: "n >= 0" },
    });
  let after = -1,
    count = 0;
  while (true) {
    const page = await admin(`/exports/${exportOp.operation_id}/pages?after=${after}`);
    for (const row of page.rows) {
      assert.equal(row.task_id, `task-${String(count).padStart(6, "0")}`);
      assert.equal(row.data.payload.seed, String(9007199254740993n + BigInt(count)));
      count++;
    }
    if (page.next === null) break;
    after = page.next;
  }
  assert.equal(count, size);
  evidence.stages.export = summary(measurements.slice(exportStart));
  console.log(`Export verified ${count} rows`);
  const burstStart = measurements.length,
    grants = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        compute(fixture.key, "/claim", {
          ...meta(),
          pool: fixture.slug,
          worker_id: `burst-${i}`,
          count: 2,
        }),
      ),
    );
  const identities = grants.flatMap((g) => g.tasks.map((t) => t.task_id));
  assert.equal(new Set(identities).size, identities.length);
  evidence.stages.burst = summary(measurements.slice(burstStart));
  for (let i = 0; i < grants.length; i++)
    await compute(fixture.key, "/report", {
      ...meta(),
      pool: fixture.slug,
      worker_id: `burst-${i}`,
      items: grants[i].tasks.map((t) => ({
        item_id: t.task_id,
        task_id: t.task_id,
        attempt_id: t.attempt_id,
        lease_token: t.lease_token,
        lease_generation: t.lease_generation,
        instance_epoch: t.instance_epoch,
        outcome: "success",
        result: { answer: t.data.n },
      })),
    });
  const steadyStart = measurements.length;
  let pending = [];
  for (let call = 0; call < steadyCalls; call++) {
    const start = performance.now();
    if (call % 2 === 0)
      pending = (
        await compute(fixture.key, "/claim", {
          ...meta(),
          pool: fixture.slug,
          worker_id: "steady",
          count: 5,
        })
      ).tasks;
    else
      await compute(fixture.key, "/report", {
        ...meta(),
        pool: fixture.slug,
        worker_id: "steady",
        items: pending.map((t) => ({
          item_id: t.task_id,
          task_id: t.task_id,
          attempt_id: t.attempt_id,
          lease_token: t.lease_token,
          lease_generation: t.lease_generation,
          instance_epoch: t.instance_epoch,
          outcome: "success",
          result: { answer: t.data.n },
        })),
      });
    if (call % 10 === 0) console.log(`Steady traffic ${call + 1}/${steadyCalls}`);
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (performance.now() - start))));
  }
  evidence.stages.steady = summary(measurements.slice(steadyStart));
  evidence.stages.claims = summary(measurements.filter((m) => m.path === "/claim"));
  evidence.stages.reports = summary(measurements.filter((m) => m.path === "/report"));
  evidence.completed = true;
} catch (error) {
  evidence.completed = false;
  evidence.failure = { code: error.code ?? error.name, message: error.message };
  console.error(error.message);
  process.exitCode = 1;
} finally {
  evidence.finished_at = new Date().toISOString();
  evidence.total = summary();
  evidence.limitations.push(
    "CPU time is separate from HTTP wall time and D1 SQL time; retrieve Worker CPU from Cloudflare analytics.",
    "Fixture is retained for history, idle and restore verification; revoke its key when those checks finish.",
  );
  await writeFile(
    `artifacts/private/verification/performance-${local ? "local" : "remote"}${suffix}.json`,
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      completed: evidence.completed,
      stages: evidence.stages,
      total: evidence.total,
    }),
  );
}
