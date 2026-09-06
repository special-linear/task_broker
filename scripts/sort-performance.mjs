import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Local by default; an explicit TEST_ORIGIN enables the existing staging Access flow.
process.env.TEST_ORIGIN ??= "http://127.0.0.1:8787";
const { origin, admin, compute, meta, measurements, summary } =
  await import("./verification-api.mjs");
const sorts = [
  { field: "a", direction: "asc" },
  { field: "b", direction: "desc" },
];
const evidence = {
  recorded_at: new Date().toISOString(),
  environment: new URL(origin).hostname === "127.0.0.1" ? "local D1" : "staging D1",
  cases: [],
};
const sizes = (process.env.SORT_BENCH_SIZES ?? "1000,10000").split(",").map(Number);
assert(sizes.every((n) => Number.isInteger(n) && n > 200 && n <= 10000));
await admin("/bootstrap", meta());
for (const size of sizes)
  for (const mode of ["default", "unindexed", "indexed"]) {
    const slug = `sort-perf-${mode}-${randomUUID().slice(0, 8)}`;
    const family = await admin("/families", { ...meta(), slug, name: slug });
    const pool = await admin("/pools", {
      ...meta(),
      family_id: family.id,
      name: slug,
      fields: [
        { key: "a", label: "A", type: "integer" },
        { key: "b", label: "B", type: "integer" },
      ],
    });
    const key = await admin("/keys", {
      ...meta(),
      family_id: family.id,
      label: "Disposable sorting benchmark",
    });
    try {
      const rows = Array.from({ length: size }, (_, i) => ({
        task_id: `row-${String(i).padStart(5, "0")}`,
        data: { a: i % 23, b: (i * 73) % 997 },
      }));
      const preview = await admin("/imports/preview", {
        ...meta(),
        pool_id: pool.id,
        mode: "add",
        total: size,
      });
      for (let start = 0; start < size; start += 50)
        await admin(`/imports/${preview.operation_id}/preview-chunks`, {
          ...meta(),
          start,
          rows: rows.slice(start, start + 50),
        });
      while (
        (await admin(`/imports/${preview.operation_id}/chunks`, { ...meta(), limit: 50 })).items
          .length
      ) {}
      const entry = { size, mode, build: null, claims: {}, concurrency: null };
      if (mode === "indexed") {
        const definition = await admin(`/pools/${pool.id}/claim-sort-indexes`, {
          ...meta(),
          name: "A then B",
          sorts,
        });
        const at = measurements.length;
        await admin(`/claim-sort-indexes/${definition.id}/build`, {
          ...meta(),
          expected_revision: 1,
        });
        entry.build = summary(measurements.slice(at));
      }
      const remaining = new Map(rows.map((r) => [r.task_id, r]));
      const compare =
        mode === "default"
          ? (a, b) => a.task_id.localeCompare(b.task_id)
          : (a, b) =>
              a.data.a - b.data.a || b.data.b - a.data.b || a.task_id.localeCompare(b.task_id);
      async function finish(worker, tasks) {
        if (!tasks.length) return;
        await compute(key.key, "/report", {
          ...meta(),
          pool: slug,
          worker_id: worker,
          items: tasks.map((t) => ({
            item_id: t.task_id,
            task_id: t.task_id,
            attempt_id: t.attempt_id,
            lease_token: t.lease_token,
            lease_generation: t.lease_generation,
            instance_epoch: t.instance_epoch,
            outcome: "success",
            result: {},
          })),
        });
      }
      for (const count of [1, 5, 20]) {
        const results = [];
        for (let repeat = 0; repeat < 5; repeat++) {
          const worker = randomUUID(),
            at = measurements.length;
          const result = await compute(key.key, "/claim", {
            ...meta(),
            pool: slug,
            worker_id: worker,
            count,
            ...(mode === "default" ? {} : { sorts }),
          });
          results.push(measurements[at]);
          assert.deepEqual(
            result.tasks.map((t) => t.task_id),
            [...remaining.values()]
              .sort(compare)
              .slice(0, count)
              .map((r) => r.task_id),
          );
          for (const t of result.tasks) remaining.delete(t.task_id);
          await finish(worker, result.tasks);
        }
        entry.claims[count] = summary(results);
      }
      const at = measurements.length;
      const concurrent = await Promise.all(
        Array.from({ length: 10 }, async () => {
          const worker = randomUUID();
          const result = await compute(key.key, "/claim", {
            ...meta(),
            pool: slug,
            worker_id: worker,
            count: 1,
            ...(mode === "default" ? {} : { sorts }),
          });
          await finish(worker, result.tasks);
          return result.tasks;
        }),
      );
      const ids = concurrent.flat().map((t) => t.task_id);
      assert.equal(new Set(ids).size, 10);
      const burst = measurements.slice(at);
      entry.concurrency = {
        overall: summary(burst),
        claims: summary(burst.filter((r) => r.path === "/claim")),
        reports: summary(burst.filter((r) => r.path === "/report")),
      };
      evidence.cases.push(entry);
      console.log(JSON.stringify(entry));
    } finally {
      await admin(`/keys/${key.id}/hard-revoke`, {
        ...meta(),
        reason: "Sorting benchmark finished",
      });
      const current = await admin(`/pools/${pool.id}`);
      await admin(
        `/pools/${pool.id}`,
        {
          ...meta(),
          expected_revision: current.config_revision,
          patch: { enabled: false, archived: true },
        },
        "PATCH",
      );
    }
  }
await mkdir("artifacts/verification", { recursive: true });
const file = `artifacts/verification/sort-performance-${evidence.environment === "local D1" ? "local" : "staging"}.json`;
await writeFile(file, JSON.stringify(evidence, null, 2) + "\n");
console.log(`Saved ${file}`);
