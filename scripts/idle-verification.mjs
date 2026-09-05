import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { compute, meta, measurements, summary, origin } from "./verification-api.mjs";
const fixture = JSON.parse(await readFile("artifacts/private/performance-remote.json", "utf8"));
const worker = "idle-verification";
const previous = process.argv.includes("--existing")
  ? JSON.parse(await readFile("artifacts/private/idle-pending.json", "utf8"))
  : null;
const warm = previous
  ? { tasks: [{ attempt_id: previous.attempt_id }] }
  : await compute(fixture.key, "/claim", {
      ...meta(),
      pool: fixture.slug,
      worker_id: worker,
      count: 1,
    });
assert.equal(warm.tasks.length, 1);
const start = new Date().toISOString(),
  duration = 30 * 60 * 1000;
await writeFile(
  "artifacts/private/idle-pending.json",
  JSON.stringify({
    start,
    expected_end: new Date(Date.now() + duration).toISOString(),
    worker,
    attempt_id: warm.tasks[0].attempt_id,
  }),
);
console.log(
  `Idle observation started ${start}; no application traffic from this verifier for 30 minutes.`,
);
await new Promise((resolve) => setTimeout(resolve, duration));
const recovery = await compute(fixture.key, "/recover", { pool: fixture.slug, worker_id: worker });
assert(recovery.tasks.some((t) => t.attempt_id === warm.tasks[0].attempt_id));
const fresh = await compute(fixture.key, "/claim", {
  ...meta(),
  pool: fixture.slug,
  worker_id: worker,
  count: 1,
});
assert.equal(fresh.tasks.length, 1);
for (const task of [...recovery.tasks, ...fresh.tasks])
  await compute(fixture.key, "/report", {
    ...meta(),
    pool: fixture.slug,
    worker_id: worker,
    items: [
      {
        item_id: task.task_id,
        task_id: task.task_id,
        attempt_id: task.attempt_id,
        lease_token: task.lease_token,
        lease_generation: task.lease_generation,
        instance_epoch: task.instance_epoch,
        outcome: "release",
      },
    ],
  });
const evidence = {
  completed: true,
  origin,
  start,
  end: new Date().toISOString(),
  duration_ms: duration,
  quota_reset_observation: !!previous,
  checks: [
    "30 minutes without verifier application requests",
    "existing lease/data recovered",
    "fresh work claimed without initialization or scheduled job",
  ],
  measurements,
  summary: summary(),
};
await writeFile(
  "artifacts/private/verification/idle-30min.json",
  JSON.stringify(evidence, null, 2),
);
console.log("PASS 30-minute idle recovery and fresh claim.");
