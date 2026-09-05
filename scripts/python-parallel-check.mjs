import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
process.env.TEST_ORIGIN = "http://127.0.0.1:8787";
const { admin, meta } = await import("./verification-api.mjs");
const slug = `parallel-${crypto.randomUUID().slice(0, 8)}`,
  family = await admin("/families", { ...meta(), slug, name: "Python parallel verifier" }),
  pool = await admin("/pools", {
    ...meta(),
    family_id: family.id,
    name: slug,
    fields: [
      { key: "n", label: "n", type: "integer" },
      { key: "diameter", label: "Diameter", type: "integer", kind: "result", pointer: "/diameter" },
    ],
  }),
  key = await admin("/keys", { ...meta(), family_id: family.id, label: "Parallel verifier" });
try {
  for (let n = 1; n <= 4; n++)
    await admin(`/pools/${pool.id}/tasks`, { ...meta(), task_id: `parallel-${n}`, data: { n } });
  await new Promise((yes, no) => {
    const child = spawn("python", ["examples/parallel_worker.py"], {
      env: {
        ...process.env,
        PYTHONPATH: resolve("python"),
        TASK_MANAGER_URL: process.env.TEST_ORIGIN,
        TASK_MANAGER_KEY: key.key,
        TASK_MANAGER_POOL: slug,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (b) => (error += b));
    child.stdout.resume();
    child.on("error", no);
    child.on("exit", (code) =>
      code ? no(new Error(error.replaceAll(key.key, "[redacted]"))) : yes(),
    );
  });
  const rows = (await admin(`/pools/${pool.id}/tasks`)).rows;
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.status, "completed");
    assert.equal(row.result.diameter, row.data.n ** 2);
  }
  await writeFile(
    "artifacts/private/verification/python-parallel.json",
    JSON.stringify(
      {
        completed: true,
        recorded_at: new Date().toISOString(),
        environment: "local Worker and D1 with real Python subprocesses",
        checks: [
          "four independent serialized handles",
          "ProcessPoolExecutor child processes report their own results",
          "all four exact result values verified",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS four Python processes completed their own serialized task handles.");
} finally {
  await admin(`/keys/${key.id}/hard-revoke`, { ...meta(), reason: "Parallel verifier complete" });
  const current = await admin(`/pools/${pool.id}`);
  await admin(
    `/pools/${pool.id}`,
    { ...meta(), expected_revision: current.config_revision, patch: { archived: true } },
    "PATCH",
  );
}
