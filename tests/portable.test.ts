import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, test, expect } from "vitest";
import handler from "../src/worker/index";
const meta = () => ({
  request_id: crypto.randomUUID(),
  request_created_at: new Date().toISOString(),
});
async function call(db: D1Database, path: string, body?: unknown, key?: string, method?: string) {
  const response = await handler.fetch(
    new Request(`http://127.0.0.1:8787${key ? "/api/v1" : "/admin-api/v1"}${path}`, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        ...(key
          ? { Authorization: `Bearer ${key}` }
          : { Origin: "http://127.0.0.1:8787", "X-Task-Broker": "1" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { ...env, DB: db },
  );
  const result = await response.json<any>();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.data;
}
beforeAll(async () => {
  for (const db of [env.DB, env.IMPORT_DB]) {
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    await call(db, "/bootstrap", meta());
  }
});
test("OPS-03/OPS-06: portable chunks preserve history, quarantine authority and replay exactly", async () => {
  const source = env.DB,
    target = env.IMPORT_DB,
    f = await call(source, "/families", { ...meta(), slug: "portable", name: "Portable family" });
  const pool = await call(source, "/pools", {
    ...meta(),
    family_id: f.id,
    name: "Portable pool",
    fields: [
      { key: "n", label: "n", type: "integer" },
      { key: "answer", label: "Answer", type: "integer", kind: "result", pointer: "/answer" },
    ],
  });
  const task = await call(source, `/pools/${pool.id}/tasks`, {
      ...meta(),
      task_id: "permanent-id",
      data: { n: "9007199254740993" },
    }),
    key = await call(source, "/keys", { ...meta(), family_id: f.id, label: "Original key" });
  const lease = (
    await call(source, "/claim", { ...meta(), pool: "portable", worker_id: "original" }, key.key)
  ).tasks[0];
  await call(
    source,
    "/report",
    {
      ...meta(),
      pool: "portable",
      worker_id: "original",
      items: [
        {
          item_id: "success",
          task_id: lease.task_id,
          attempt_id: lease.attempt_id,
          lease_token: lease.lease_token,
          lease_generation: lease.lease_generation,
          instance_epoch: lease.instance_epoch,
          outcome: "success",
          result: { answer: "9007199254740993" },
        },
      ],
    },
    key.key,
  );
  await call(source, "/views", {
    ...meta(),
    pool_id: pool.id,
    profile_id: pool.profile_id,
    name: "Shared",
    shared: true,
    presentation: { filter: "n > 2", columns: [], page_size: 50 },
  });
  await call(source, "/maintenance", { ...meta(), maintenance: true });
  await call(target, "/maintenance", { ...meta(), maintenance: true });
  const manifest = await call(source, "/portable-export");
  expect(manifest.consistent).toBe(true);
  expect((await call(source, `/pools/${pool.id}`)).created_at).toMatch(/Z$/);
  const chunks: { table: string; rows: any[] }[] = [];
  for (const table of manifest.tables) {
    let after = 0;
    while (true) {
      const page = await call(source, `/portable-export/pages?table=${table}&after=${after}`);
      if (page.rows.length) chunks.push({ table, rows: page.rows });
      if (page.next === null) break;
      after = Number(page.next);
    }
  }
  expect(JSON.stringify(chunks)).not.toContain(lease.lease_token);
  expect(JSON.stringify(chunks)).not.toContain(key.key);
  const op = await call(target, "/portable-import/preview", {
    ...meta(),
    manifest,
    total_records: chunks.reduce((n, c) => n + c.rows.length, 0),
  });
  for (const chunk of chunks) {
    const body = { ...meta(), ...chunk };
    const first = await call(target, `/portable-import/${op.operation_id}/chunks`, body);
    expect(await call(target, `/portable-import/${op.operation_id}/chunks`, body)).toEqual(first);
  }
  const progress = await call(target, `/operations/${op.operation_id}`);
  expect(progress.status).toBe("complete");
  expect(progress.processed).toBe(progress.total);
  const restored = (await call(target, `/tasks/${task.task_uid}`)).task;
  expect(restored.task_id).toBe("permanent-id");
  expect(restored.data.n).toBe("9007199254740993");
  expect(restored.result.answer).toBe("9007199254740993");
  const history = await call(target, `/tasks/${task.task_uid}/attempts`);
  expect(history.attempts[0].id).toBe(lease.attempt_id);
  expect(history.attempts[0].result.answer).toBe("9007199254740993");
  const keys = (await call(target, "/keys")).rows;
  expect(keys[0].status).toBe("hard_revoked");
  expect((await call(target, `/pools/${pool.id}`)).enabled).toBe(0);
  expect((await target.prepare("SELECT count(*) n FROM lease_heads").first<any>())?.n).toBe(0);
  expect((await target.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
