import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import {
  defaultSorts,
  promoteSort,
  taskComparator,
  sortKeys,
  type SortSpec,
} from "../src/shared/sort";
import { indexDefinition, physicalIndexName } from "../src/worker/sort-indexes";
import type { Field } from "../src/shared/core";
import handler from "../src/worker/index";

const meta = () => ({
  request_id: crypto.randomUUID(),
  request_created_at: new Date().toISOString(),
});
async function request(path: string, body?: unknown, key?: string, method?: string) {
  const response = await SELF.fetch(
    `http://127.0.0.1:8787/${key ? "api" : "admin-api"}/v1${path}`,
    {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        ...(key
          ? { Authorization: `Bearer ${key}` }
          : { Origin: "http://127.0.0.1:8787", "X-Task-Broker": "1" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  return response.json<any>();
}
async function ok(path: string, body?: unknown, key?: string, method?: string) {
  const r = await request(path, body, key, method);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r.data;
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await ok("/bootstrap", meta());
});

async function fixture(data: Record<string, unknown>[] = []) {
  const slug = "sorting-" + crypto.randomUUID().slice(0, 8);
  const family = await ok("/families", { ...meta(), slug, name: slug });
  const pool = await ok("/pools", {
    ...meta(),
    family_id: family.id,
    name: slug,
    fields: [
      { key: "a", label: "Group", type: "string" },
      { key: "b", label: "Size", type: "integer" },
      { key: 'odd."key\\x', label: "Odd key", type: "number" },
      { key: "payload", label: "Payload", type: "json" },
    ],
  });
  const key = await ok("/keys", { ...meta(), family_id: family.id, label: "Sort test" });
  for (const [i, row] of data.entries())
    await ok(`/pools/${pool.id}/tasks`, {
      ...meta(),
      task_id: `row-${String(i).padStart(3, "0")}`,
      data: row,
    });
  const fields = (await ok(`/pools/${pool.id}/fields`)).fields as Field[];
  return { family: family.id, pool: pool.id, profile: pool.profile_id, key: key.key, slug, fields };
}
async function pages(pool: string, sorts: SortSpec, limit = 2) {
  const rows: any[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ sorts: JSON.stringify(sorts), limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    const page = await ok(`/pools/${pool}/tasks?${q}`);
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  return rows;
}
const claim = (f: Awaited<ReturnType<typeof fixture>>, sorts?: SortSpec, extra = {}) =>
  ok(
    "/claim",
    {
      ...meta(),
      pool: f.slug,
      worker_id: crypto.randomUUID(),
      count: 20,
      ...(sorts ? { sorts } : {}),
      ...extra,
    },
    f.key,
  );

test("stable sort promotion preserves complete history and rejects silent truncation", () => {
  let s = promoteSort(defaultSorts(), "b");
  s = promoteSort(s, "a");
  expect(s.map((x) => x.field)).toEqual(["a", "b", "task_id"]);
  s = promoteSort(s, "a");
  expect(s[0].direction).toBe("desc");
  s = promoteSort(s, "b");
  expect(s).toEqual([
    { field: "b", direction: "asc" },
    { field: "a", direction: "desc" },
    { field: "task_id", direction: "asc" },
  ]);
  for (let i = 0; i < 5; i++) s = promoteSort(s, "f" + i);
  expect(() => promoteSort(s, "ninth")).toThrow(/eight/);
});

test("multi-column cursors, exports and browser comparator agree for nulls, Unicode and exact integers", async () => {
  const f = await fixture([
    { a: "b", b: 2 },
    { a: "a", b: "9223372036854775809" },
    { a: "a", b: -2 },
    { a: "a", b: "-9223372036854775809" },
    { a: null, b: 1 },
    { a: "a", b: null },
    { a: "a", b: -2 },
    { a: "\u{10000}", b: 0 },
    { a: "\ue000", b: 0 },
  ]);
  const original = await pages(f.pool, defaultSorts());
  for (const direction of ["asc", "desc"] as const) {
    const sorts: SortSpec = [
      { field: "a", direction },
      { field: "b", direction },
      ...defaultSorts(),
    ];
    const rows = await pages(f.pool, sorts);
    expect(rows.map((r) => r.task_uid)).toEqual(
      [...original].sort(taskComparator(sorts, f.fields)).map((r) => r.task_uid),
    );
    expect(new Set(rows.map((r) => r.task_uid)).size).toBe(original.length);
    expect(rows[0].data.a).toBeNull();
    const exportOp = await ok("/exports", { ...meta(), pool_id: f.pool, selection: {}, sorts });
    const exported = await ok(`/exports/${exportOp.operation_id}/pages`);
    expect(exported.rows.map((r: any) => r.task_uid)).toEqual(rows.map((r) => r.task_uid));
    const first = await ok(
      `/pools/${f.pool}/tasks?sorts=${encodeURIComponent(JSON.stringify(sorts))}&limit=2`,
    );
    const bad = await request(
      `/pools/${f.pool}/tasks?sorts=${encodeURIComponent(JSON.stringify(sorts.slice(1)))}&limit=2&cursor=${encodeURIComponent(first.cursor)}`,
    );
    expect(bad.ok).toBe(false);
  }
  const ascending = await pages(f.pool, [
    { field: "a", direction: "asc" },
    { field: "b", direction: "asc" },
    ...defaultSorts(),
  ]);
  expect(ascending.map((r) => r.task_id)).toEqual([
    "row-004",
    "row-005",
    "row-003",
    "row-002",
    "row-006",
    "row-001",
    "row-000",
    "row-008",
    "row-007",
  ]);
  expect((await request(`/pools/${f.pool}/tasks?sort=a&sorts=[]`)).ok).toBe(false);
  expect(
    (
      await request(
        `/pools/${f.pool}/tasks?sorts=${encodeURIComponent(
          JSON.stringify([
            { field: "a", direction: "asc" },
            { field: "Group", direction: "asc" },
          ]),
        )}`,
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await request(
        `/pools/${f.pool}/tasks?sorts=${encodeURIComponent('[{"field":"payload","direction":"asc"}]')}`,
      )
    ).ok,
  ).toBe(false);
  const legacy = await ok(`/pools/${f.pool}/tasks?sort=b&direction=desc`);
  expect(legacy.rows).toHaveLength(original.length);
  const view = await ok("/views", {
    ...meta(),
    pool_id: f.pool,
    name: "Legacy view",
    presentation: { sort: "b", direction: "desc", page_size: 50 },
  });
  const saved = (await ok("/views")).rows.find((r: any) => r.id === view.id);
  const presentation = saved.presentation ?? JSON.parse(saved.presentation_json);
  expect(presentation.sorts).toEqual([{ field: "b", direction: "desc" }]);
  await ok("/views", {
    ...meta(),
    pool_id: f.pool,
    name: "All view",
    presentation: { sorts: [], page_size: "all" },
  });
});

test("ordered claims preserve fresh and retry-age priority, replay and allowlists", async () => {
  const f = await fixture([{ b: 9 }, { b: 3 }, { b: 1 }, { b: 5 }]);
  const sorts: SortSpec = [{ field: "b", direction: "asc" }];
  const body = { ...meta(), pool: f.slug, worker_id: "replay", sorts, count: 2 };
  const first = await ok("/claim", body, f.key);
  expect(first.tasks.map((t: any) => t.data.b)).toEqual([1, 3]);
  expect((await ok("/claim", body, f.key)).tasks).toEqual(first.tasks);
  expect(
    (await request("/claim", { ...body, sorts: [{ field: "b", direction: "desc" }] }, f.key)).error
      .code,
  ).toBe("IDEMPOTENCY_CONFLICT");
  await ok(
    "/report",
    {
      ...meta(),
      pool: f.slug,
      worker_id: "replay",
      items: first.tasks.map((t: any, i: number) => ({
        item_id: String(i),
        task_id: t.task_id,
        attempt_id: t.attempt_id,
        lease_token: t.lease_token,
        lease_generation: t.lease_generation,
        instance_epoch: t.instance_epoch,
        outcome: "release",
      })),
    },
    f.key,
  );
  // A retry with b=3 is older than b=1; both remain behind all fresh work.
  await env.DB.prepare(
    "UPDATE task_profile_state SET last_grant_at=CASE WHEN task_uid=(SELECT task_uid FROM tasks WHERE pool_id=? AND task_id='row-001') THEN 1 ELSE 2 END WHERE profile_id=?",
  )
    .bind(f.pool, f.profile)
    .run();
  expect((await claim(f, sorts)).tasks.map((t: any) => t.data.b)).toEqual([5, 9, 3, 1]);
  await ok(
    `/profiles/${f.profile}`,
    { ...meta(), expected_revision: 1, patch: { filter_allowlist: [] } },
    undefined,
    "PATCH",
  );
  expect(
    (await request("/claim", { ...meta(), pool: f.slug, worker_id: "forbidden", sorts }, f.key))
      .error.code,
  ).toBe("FORBIDDEN");
});

test.each([false, true])(
  "full reset returns the first five tasks to their two-column claim order (indexed: %s)",
  async (indexed) => {
    const f = await fixture([
      { a: "3", b: 1 },
      ...Array.from({ length: 7 }, (_, i) => ({ a: "2", b: 8 - i })),
    ]);
    const sorts: SortSpec = [
      { field: "a", direction: "asc" },
      { field: "b", direction: "asc" },
    ];
    if (indexed) {
      const index = await ok(`/pools/${f.pool}/claim-sort-indexes`, {
        ...meta(),
        name: "Reset order",
        sorts,
      });
      await ok(`/claim-sort-indexes/${index.id}/build`, { ...meta(), expected_revision: 1 });
    }
    const originalRequest = { ...meta(), pool: f.slug, worker_id: "before-reset", count: 5, sorts };
    const original = await ok("/claim", originalRequest, f.key);
    expect(original.tasks.map((t: any) => t.data.b)).toEqual([2, 3, 4, 5, 6]);
    const rows = (await pages(f.pool, sorts, 100)).slice(0, 5);
    const preview = await ok("/tasks/bulk/preview", {
      ...meta(),
      pool_id: f.pool,
      selection: { ids: rows.map((t) => t.task_uid) },
      action: { kind: "reset", mode: "full", scope: "all", revoke: true },
    });
    const reset = await ok(`/operations/${preview.operation_id}/apply`, { ...meta(), limit: 50 });
    expect(reset.items.map((i: any) => i.status)).toEqual(Array(5).fill("applied"));
    expect((await pages(f.pool, sorts, 100)).slice(0, 5)).toEqual(
      rows.map((row) =>
        expect.objectContaining({ task_uid: row.task_uid, attempts_total: 0, status: "pending" }),
      ),
    );
    // Existing receipts keep their original grants; only a new request selects again.
    expect((await ok("/claim", originalRequest, f.key)).tasks).toEqual(original.tasks);
    const next = await claim(f, sorts, { count: 5 });
    expect(next.tasks.map((t: any) => t.task_id)).toEqual(
      original.tasks.map((t: any) => t.task_id),
    );
    for (const [i, task] of next.tasks.entries()) {
      expect(task.attempts).toBe(1);
      expect(task.attempts_total).toBe(1);
      expect(task.attempt_id).not.toBe(original.tasks[i].attempt_id);
      expect(task.lease_generation).toBeGreaterThan(original.tasks[i].lease_generation);
    }
    const state = await env.DB.prepare(
      "SELECT t.attempt_sequence,t.lifetime_attempts,ps.attempts,ps.lifetime_attempts profile_lifetime,(SELECT count(*) FROM attempts a WHERE a.task_uid=t.task_uid) history_count FROM tasks t JOIN task_profile_state ps ON ps.task_uid=t.task_uid WHERE t.pool_id=? AND ps.profile_id=?",
    )
      .bind(f.pool, f.profile)
      .all();
    expect(state.results).toEqual(
      Array(5).fill({
        attempt_sequence: 2,
        lifetime_attempts: 2,
        attempts: 1,
        profile_lifetime: 2,
        history_count: 2,
      }),
    );
    const stale = await ok(
      "/renew",
      {
        ...meta(),
        pool: f.slug,
        worker_id: "before-reset",
        items: original.tasks.map((t: any) => ({
          item_id: t.task_id,
          task_id: t.task_id,
          attempt_id: t.attempt_id,
          lease_token: t.lease_token,
          lease_generation: t.lease_generation,
          instance_epoch: t.instance_epoch,
          lease_seconds: 60,
        })),
      },
      f.key,
    );
    expect(stale.items.map((i: any) => i.error.code)).toEqual(Array(5).fill("STALE_LEASE"));
    expect((await claim(f, sorts)).tasks.map((t: any) => t.data)).toEqual([
      { a: "2", b: 7 },
      { a: "2", b: 8 },
      { a: "3", b: 1 },
    ]);
  },
);

test.each([
  { mode: "full", scope: "profile" },
  { mode: "full", scope: "all" },
  { mode: "soft", scope: "profile" },
  { mode: "soft", scope: "all" },
])(
  "$scope $mode reset changes freshness only for reset profile counters",
  async ({ mode, scope }) => {
    const f = await fixture([{ b: 1 }, { b: 2 }]);
    const other = await ok("/profiles", {
      ...meta(),
      family_id: f.family,
      pool_id: f.pool,
      slug: "other",
      name: "Other",
    });
    const release = async (pool: string, tasks: any[]) => {
      const result = await ok(
        "/report",
        {
          ...meta(),
          pool,
          worker_id: "reset-scope",
          items: tasks.map((t) => ({
            item_id: t.task_id,
            task_id: t.task_id,
            attempt_id: t.attempt_id,
            lease_token: t.lease_token,
            lease_generation: t.lease_generation,
            instance_epoch: t.instance_epoch,
            outcome: "release",
          })),
        },
        f.key,
      );
      expect(result.items.every((i: any) => i.status === "applied")).toBe(true);
    };
    for (const pool of [f.slug, `${f.slug}/other`]) {
      const first = await claim(f, undefined, { pool, worker_id: "reset-scope", count: 1 });
      expect(first.tasks.map((t: any) => t.data.b)).toEqual([1]);
      await release(pool, first.tasks);
    }
    const rows = await pages(f.pool, defaultSorts());
    const preview = await ok("/tasks/bulk/preview", {
      ...meta(),
      pool_id: f.pool,
      profile_id: f.profile,
      selection: { ids: [rows[0].task_uid] },
      action: { kind: "reset", mode, scope },
    });
    const reset = await ok(`/operations/${preview.operation_id}/apply`, { ...meta(), limit: 50 });
    expect(reset.items[0].status).toBe("applied");
    const states = await env.DB.prepare(
      "SELECT profile_id,attempts,lifetime_attempts FROM task_profile_state WHERE task_uid=? ORDER BY profile_id",
    )
      .bind(rows[0].task_uid)
      .all();
    expect(states.results).toEqual(
      [f.profile, other.id].sort().map((profile_id) => ({
        profile_id,
        attempts: mode === "full" && (scope === "all" || profile_id === f.profile) ? 0 : 1,
        lifetime_attempts: 1,
      })),
    );
    const otherNext = await claim(f, undefined, {
      pool: `${f.slug}/other`,
      worker_id: "reset-scope",
      count: 1,
    });
    expect(otherNext.tasks.map((t: any) => t.data.b)).toEqual([
      mode === "full" && scope === "all" ? 1 : 2,
    ]);
    await release(`${f.slug}/other`, otherNext.tasks);
    const next = await claim(f, undefined, { count: 1 });
    expect(next.tasks.map((t: any) => t.data.b)).toEqual([mode === "full" ? 1 : 2]);
  },
);

test("configured expression indexes build atomically, handle unusual keys, and invalidate on schema changes", async () => {
  const field = 'odd."key\\x';
  const f = await fixture([
    { [field]: 4, b: 2 },
    { [field]: 1, b: 1 },
    { [field]: 3, b: 0 },
  ]);
  const sorts: SortSpec = [
    { field, direction: "desc" },
    { field: "b", direction: "asc" },
  ];
  const index = await ok(`/pools/${f.pool}/claim-sort-indexes`, {
    ...meta(),
    name: "Odd key sort",
    sorts,
  });
  const build = { ...meta(), expected_revision: 1 };
  expect((await ok(`/claim-sort-indexes/${index.id}/build`, build)).status).toBe("ready");
  expect((await ok(`/claim-sort-indexes/${index.id}/build`, build)).revision).toBe(2);
  const definition = indexDefinition(f.fields, sorts);
  const plan = await env.DB.prepare(
    `EXPLAIN QUERY PLAN SELECT task_uid FROM tasks WHERE pool_id=? AND deleted_at IS NULL AND completed_at IS NULL AND enabled=1 AND valid=1 ORDER BY ${definition.order} LIMIT 20`,
  )
    .bind(f.pool)
    .all();
  expect(JSON.stringify(plan.results)).toContain(physicalIndexName(index.id));
  expect(JSON.stringify(plan.results)).not.toContain("TEMP B-TREE");
  expect((await claim(f, sorts)).tasks.map((t: any) => t.data[field])).toEqual([4, 3, 1]);
  const nextFields = f.fields.map((f) => (f.key === field ? { ...f, key: "renamed" } : f));
  const preview = await ok(`/pools/${f.pool}/fields/preview`, {
    ...meta(),
    expected_revision: 1,
    fields: nextFields,
  });
  await ok(`/pools/${f.pool}/fields/apply`, {
    ...meta(),
    operation_id: preview.operation_id,
    revoke: true,
  });
  const rows = (await ok(`/pools/${f.pool}/claim-sort-indexes`)).rows;
  expect(rows[0].status).toBe("unbuilt");
  expect(rows[0].sorts[0].field).toBe("renamed");
  expect(
    (
      await env.DB.prepare("SELECT name FROM sqlite_schema WHERE name=?")
        .bind(physicalIndexName(index.id))
        .all()
    ).results,
  ).toHaveLength(0);
});

test("claim top-k matches reference order for k=1/5/20 and concurrent batches never overlap", async () => {
  for (const k of [1, 5, 20]) {
    const f = await fixture(
      Array.from({ length: 25 }, (_, i) => ({ a: String(i % 3), b: (i * 17) % 31 })),
    );
    const sorts: SortSpec = [
      { field: "a", direction: "asc" },
      { field: "b", direction: "desc" },
    ];
    const ordered = await pages(f.pool, [...sorts, ...defaultSorts()], 100);
    const grants = await claim(f, sorts, { count: k });
    expect(grants.tasks.map((r: any) => r.task_id)).toEqual(
      ordered.slice(0, k).map((r) => r.task_id),
    );
    const concurrent = await Promise.all([
      claim(f, sorts, { count: 5 }),
      claim(f, sorts, { count: 5 }),
    ]);
    const ids = [...grants.tasks, ...concurrent.flatMap((r) => r.tasks)].map((r) => r.task_id);
    expect(new Set(ids).size).toBe(ids.length);
  }
});

test("actual claim SQL uses a bounded sorter without an index and an index scan with one", async () => {
  const f = await fixture(Array.from({ length: 30 }, (_, i) => ({ b: 30 - i })));
  const sorts: SortSpec = [{ field: "b", direction: "asc" }];
  let selectionSQL = "";
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.startsWith("WITH fresh AS MATERIALIZED")) selectionSQL = sql;
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await handler.fetch(
    new Request("http://127.0.0.1:8787/api/v1/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.key}` },
      body: JSON.stringify({ ...meta(), pool: f.slug, worker_id: "plans", count: 1, sorts }),
    }),
    { ...env, DB: db },
  );
  expect(response.status).toBe(200);
  expect(selectionSQL).not.toBe("");
  const freshSQL = selectionSQL
    .slice(selectionSQL.indexOf("SELECT"), selectionSQL.indexOf(", retried AS MATERIALIZED"))
    .trim()
    .replace(/\)$/, "");
  const opcodes = (await env.DB.prepare(`EXPLAIN ${freshSQL}`).all()).results.map((r) => r.opcode);
  // SQLite's LIMIT sorter prunes the worst retained row once k candidates are held.
  expect(opcodes).toEqual(expect.arrayContaining(["IfNotZero", "Last", "IdxLE", "Delete", "Sort"]));
  const index = await ok(`/pools/${f.pool}/claim-sort-indexes`, { ...meta(), name: "Plan", sorts });
  await ok(`/claim-sort-indexes/${index.id}/build`, { ...meta(), expected_revision: 1 });
  const plan = JSON.stringify(
    (await env.DB.prepare(`EXPLAIN QUERY PLAN ${freshSQL}`).all()).results,
  );
  expect(plan).toContain(physicalIndexName(index.id));
  expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
  const indexedOpcodes = (await env.DB.prepare(`EXPLAIN ${freshSQL}`).all()).results.map(
    (r) => r.opcode,
  );
  expect(indexedOpcodes).not.toContain("Sort");
});

test("index maintenance, rebuild, label-only changes, deletion and the four-definition limit", async () => {
  const f = await fixture([{ b: 3 }, { b: 1 }, { b: 2 }]);
  const sorts: SortSpec = [{ field: "b", direction: "asc" }];
  const index = await ok(`/pools/${f.pool}/claim-sort-indexes`, { ...meta(), name: "Main", sorts });
  await ok(`/claim-sort-indexes/${index.id}/build`, { ...meta(), expected_revision: 1 });
  await ok(`/claim-sort-indexes/${index.id}/build`, { ...meta(), expected_revision: 2 });
  for (let i = 0; i < 3; i++)
    await ok(`/pools/${f.pool}/claim-sort-indexes`, { ...meta(), name: "Extra " + i, sorts });
  expect(
    (await request(`/pools/${f.pool}/claim-sort-indexes`, { ...meta(), name: "Fifth", sorts })).ok,
  ).toBe(false);
  const first = (await pages(f.pool, defaultSorts()))[0];
  await ok(
    `/tasks/${first.task_uid}`,
    { ...meta(), expected_edit_revision: first.edit_revision, patch: { data: { b: -10 } } },
    undefined,
    "PATCH",
  );
  const preview = await ok(`/pools/${f.pool}/fields/preview`, {
    ...meta(),
    expected_revision: 1,
    fields: f.fields.map((field) => ({ ...field, label: field.label + " label" })),
  });
  await ok(`/pools/${f.pool}/fields/apply`, { ...meta(), operation_id: preview.operation_id });
  expect(
    (await ok(`/pools/${f.pool}/claim-sort-indexes`)).rows.find((r: any) => r.id === index.id),
  ).toMatchObject({ status: "ready", revision: 3 });
  expect((await claim(f, sorts)).tasks.map((t: any) => t.data.b)).toEqual([-10, 1, 2]);
  await ok(
    `/claim-sort-indexes/${index.id}`,
    { ...meta(), expected_revision: 3 },
    undefined,
    "DELETE",
  );
  expect(
    (
      await env.DB.prepare("SELECT name FROM sqlite_schema WHERE name=?")
        .bind(physicalIndexName(index.id))
        .all()
    ).results,
  ).toHaveLength(0);
  expect((await ok(`/pools/${f.pool}/claim-sort-indexes`)).rows).toHaveLength(3);
});

test("numeric, Boolean and datetime sorting agrees between SQL and browser", async () => {
  const f = await fixture();
  const nextFields = [
    ...f.fields,
    { key: "flag", label: "Flag", type: "boolean" },
    { key: "date", label: "Date", type: "datetime" },
  ];
  const preview = await ok(`/pools/${f.pool}/fields/preview`, {
    ...meta(),
    expected_revision: 1,
    fields: nextFields,
  });
  await ok(`/pools/${f.pool}/fields/apply`, { ...meta(), operation_id: preview.operation_id });
  const fields = (await ok(`/pools/${f.pool}/fields`)).fields;
  const field = 'odd."key\\x';
  const values = [
    {},
    { flag: null, date: null, [field]: null },
    { a: "Infinity", flag: false, date: "2026-01-01T00:00:00Z", [field]: 1.25 },
    { a: "-Infinity", flag: true, date: "2025-12-31T23:00:00-02:00", [field]: -2.5 },
    { a: "NaN", flag: false, date: "2026-01-01T02:00:00+02:00", [field]: 0 },
  ];
  for (const [i, data] of values.entries())
    await ok(`/pools/${f.pool}/tasks`, { ...meta(), task_id: "typed-" + i, data });
  const original = await pages(f.pool, defaultSorts());
  for (const key of [field, "flag", "date", "a", "Group"])
    for (const direction of ["asc", "desc"] as const) {
      const sorts: SortSpec = [{ field: key, direction }, ...defaultSorts()];
      expect((await pages(f.pool, sorts, 1)).map((r) => r.task_uid)).toEqual(
        [...original].sort(taskComparator(sorts, fields)).map((r) => r.task_uid),
      );
      if (key === "Group") expect(sortKeys(sorts, fields)[0].field).toBe("a");
    }
});

test("retry ties use requested sorts while filters and capacity still limit grants", async () => {
  const f = await fixture([{ b: 2 }, { b: 3 }, { b: 1 }]);
  const initial = await claim(f, undefined, { worker_id: "retry" });
  await ok(
    "/report",
    {
      ...meta(),
      pool: f.slug,
      worker_id: "retry",
      items: initial.tasks.map((t: any) => ({
        item_id: t.task_id,
        task_id: t.task_id,
        attempt_id: t.attempt_id,
        lease_token: t.lease_token,
        lease_generation: t.lease_generation,
        instance_epoch: t.instance_epoch,
        outcome: "release",
      })),
    },
    f.key,
  );
  await env.DB.prepare("UPDATE task_profile_state SET last_grant_at=1 WHERE profile_id=?")
    .bind(f.profile)
    .run();
  await ok(
    `/profiles/${f.profile}`,
    { ...meta(), expected_revision: 1, patch: { policy: { profile_cap: 1 } } },
    undefined,
    "PATCH",
  );
  const result = await claim(f, [{ field: "b", direction: "asc" }], { filter: "b > 1" });
  expect(result.tasks.map((t: any) => t.data.b)).toEqual([2]);
  expect(result.limiting_reasons).toContain("PROFILE_CAP");
});

test("failed index builds preserve the definition and can be retried", async () => {
  const f = await fixture([{ b: 2 }]);
  const index = await ok(`/pools/${f.pool}/claim-sort-indexes`, {
    ...meta(),
    name: "Retry build",
    sorts: [{ field: "b", direction: "asc" }],
  });
  const name = physicalIndexName(index.id);
  // An unrelated object occupying the generated name forces CREATE INDEX to fail.
  await env.DB.prepare(`CREATE TABLE ${name}(id INTEGER)`).run();
  try {
    expect(
      (await request(`/claim-sort-indexes/${index.id}/build`, { ...meta(), expected_revision: 1 }))
        .ok,
    ).toBe(false);
    expect((await ok(`/pools/${f.pool}/claim-sort-indexes`)).rows[0]).toMatchObject({
      status: "unbuilt",
      revision: 1,
    });
    expect((await claim(f, [{ field: "b", direction: "asc" }])).tasks).toHaveLength(1);
  } finally {
    await env.DB.prepare(`DROP TABLE ${name}`).run();
  }
  expect(
    (await ok(`/claim-sort-indexes/${index.id}/build`, { ...meta(), expected_revision: 1 })).status,
  ).toBe("ready");
});

test("export ordinals stay frozen across pages while task values remain live", async () => {
  const f = await fixture(Array.from({ length: 105 }, (_, i) => ({ b: i % 7 })));
  const sorts: SortSpec = [{ field: "b", direction: "desc" }, ...defaultSorts()];
  const ordered = await pages(f.pool, sorts, 100);
  const op = await ok("/exports", { ...meta(), pool_id: f.pool, selection: {}, sorts });
  const last = ordered.at(-1)!;
  await ok(
    `/tasks/${last.task_uid}`,
    { ...meta(), expected_edit_revision: last.edit_revision, patch: { data: { b: 999 } } },
    undefined,
    "PATCH",
  );
  const first = await ok(`/exports/${op.operation_id}/pages`);
  const second = await ok(`/exports/${op.operation_id}/pages?after=${first.next}`);
  expect([...first.rows, ...second.rows].map((r: any) => r.task_uid)).toEqual(
    ordered.map((r) => r.task_uid),
  );
  expect(second.rows.at(-1).data.b).toBe(999);
  expect(second.manifest.sorts).toEqual(sorts);
  const selected = await ok("/exports", {
    ...meta(),
    pool_id: f.pool,
    selection: {
      ids: ordered
        .slice(0, 3)
        .map((r) => r.task_uid)
        .reverse(),
    },
    sorts,
  });
  expect(
    (await ok(`/exports/${selected.operation_id}/pages`)).rows.map((r: any) => r.task_uid),
  ).toEqual(ordered.slice(0, 3).map((r) => r.task_uid));
});
