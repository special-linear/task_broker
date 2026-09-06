/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
const meta = () => ({
  request_id: crypto.randomUUID(),
  request_created_at: new Date().toISOString(),
});
async function admin(path: string, data?: unknown, method = "POST") {
  const response = await SELF.fetch(`http://127.0.0.1:8787/admin-api/v1${path}`, {
    method: data === undefined ? "GET" : method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:8787",
      "X-Task-Broker": "1",
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { status: response.status, ...(await response.json<any>()) };
}
async function compute(key: string, path: string, body: unknown) {
  const response = await SELF.fetch(`http://127.0.0.1:8787/api/v1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json<any>()) };
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect((await admin("/bootstrap", meta())).ok).toBe(true);
});
async function fixture(count = 1, resultType = "integer", resultPointer = "/diameter") {
  const slug = `test-${crypto.randomUUID().slice(0, 8)}`;
  const family = await admin("/families", {
    ...meta(),
    slug,
    name: "Test family",
  });
  expect(family.ok, JSON.stringify(family)).toBe(true);
  const pool = await admin("/pools", {
    ...meta(),
    family_id: family.data.id,
    name: "Experiments",
    fields: [
      { key: "n", label: "n", type: "integer", required: true },
      {
        key: "diameter",
        label: "Diameter",
        type: resultType,
        kind: "result",
        pointer: resultPointer,
      },
    ],
  });
  expect(pool.ok, JSON.stringify(pool)).toBe(true);
  const key = await admin("/keys", {
    ...meta(),
    family_id: family.data.id,
    label: "test",
  });
  expect(key.ok, JSON.stringify(key)).toBe(true);
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const task = await admin(`/pools/${pool.data.id}/tasks`, {
      ...meta(),
      task_id: `task-${i}`,
      data: { n: i },
    });
    expect(task.ok, JSON.stringify(task)).toBe(true);
    tasks.push(task.data);
  }
  return {
    slug,
    family: family.data.id,
    pool: pool.data.id,
    profile: pool.data.profile_id,
    key: key.data.key,
    keyId: key.data.id,
    tasks,
  };
}
test("UI-01/UI-02/PY flow: create, claim, immutable replay, report, grid result", async () => {
  const f = await fixture();
  const body = { ...meta(), pool: f.slug, worker_id: "worker-1", count: 1 };
  const claimed = await compute(f.key, "/claim", body);
  expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
  expect(claimed.data.tasks).toHaveLength(1);
  const replay = await compute(f.key, "/claim", body);
  expect(replay.data).toEqual(claimed.data);
  const t = claimed.data.tasks[0];
  expect(t.data).toEqual({ n: 0 });
  const result = await compute(f.key, "/report", {
    ...meta(),
    pool: f.slug,
    worker_id: "worker-1",
    items: [
      {
        item_id: "one",
        task_id: t.task_id,
        attempt_id: t.attempt_id,
        lease_token: t.lease_token,
        lease_generation: t.lease_generation,
        instance_epoch: t.instance_epoch,
        outcome: "success",
        result: { diameter: 42 },
        runtime_seconds: 0.0123456789,
        runtime_origin: "received",
      },
    ],
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.data.items[0].status, JSON.stringify(result)).toBe("applied");
  const rows = await admin(`/pools/${f.pool}/tasks`);
  expect(rows.ok, JSON.stringify(rows)).toBe(true);
  expect(rows.data.rows[0].status).toBe("completed");
  expect(rows.data.rows[0].result).toEqual({ diameter: 42 });
  const history = await admin(`/tasks/${f.tasks[0].task_uid}/attempts`);
  expect(history.data.attempts[0].runtime_seconds).toBe(0.0123456789);
  expect(history.data.attempts[0].runtime_origin).toBe("received");
});
test.each(["report", "renew"])(
  "%s validation identifies the malformed field and preserves the error on replay",
  async (endpoint) => {
    const f = await fixture();
    const grant = await compute(f.key, "/claim", { ...meta(), pool: f.slug, worker_id: "w" });
    const t = grant.data.tasks[0];
    const field = endpoint === "report" ? "runtime_seconds" : "lease_seconds";
    const item = {
      item_id: "invalid",
      task_id: t.task_id,
      attempt_id: t.attempt_id,
      lease_token: t.lease_token,
      lease_generation: t.lease_generation,
      instance_epoch: t.instance_epoch,
      ...(endpoint === "report" ? { outcome: "success", result: { diameter: 4 } } : {}),
      [field]: "not-a-number",
    };
    const body = { ...meta(), pool: f.slug, worker_id: "w", items: [item] };
    const rejected = await compute(f.key, `/${endpoint}`, body);
    expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
    expect(rejected.data.items[0]).toMatchObject({
      status: "rejected",
      error: { code: "INVALID_VALUE", message: expect.stringContaining(`${field}:`) },
    });
    expect(rejected.data.items[0].error.message).toContain("expected number");
    expect(JSON.stringify(rejected)).not.toContain(t.lease_token);
    expect((await compute(f.key, `/${endpoint}`, body)).data).toEqual(rejected.data);
    const recovered = await compute(f.key, "/recover", { pool: f.slug, worker_id: "w" });
    expect(recovered.data.tasks[0].attempt_id).toBe(t.attempt_id);
    const corrected = await compute(f.key, `/${endpoint}`, {
      ...body,
      ...meta(),
      items: [{ ...item, item_id: "corrected", [field]: endpoint === "report" ? 0.125 : 7200 }],
    });
    expect(corrected.data.items[0].status, JSON.stringify(corrected)).toBe("applied");
  },
);
test("result type errors retain the column name and required type", async () => {
  const f = await fixture(1, "string");
  const grant = await compute(f.key, "/claim", { ...meta(), pool: f.slug, worker_id: "w" });
  const t = grant.data.tasks[0];
  const item = {
    item_id: "invalid-result",
    task_id: t.task_id,
    attempt_id: t.attempt_id,
    lease_token: t.lease_token,
    lease_generation: t.lease_generation,
    instance_epoch: t.instance_epoch,
    outcome: "success",
    result: { diameter: 4 },
    runtime_seconds: 0.0123456789,
    runtime_origin: "received",
  };
  const body = { ...meta(), pool: f.slug, worker_id: "w", items: [item] };
  const rejected = await compute(f.key, "/report", body);
  expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
  expect(rejected.data.items[0]).toMatchObject({
    status: "rejected",
    error: { code: "INVALID_VALUE", message: "Diameter must be text." },
  });
  expect((await compute(f.key, "/report", body)).data).toEqual(rejected.data);
  expect(JSON.stringify(rejected)).not.toContain(t.lease_token);
  const corrected = await compute(f.key, "/report", {
    ...body,
    ...meta(),
    items: [{ ...item, item_id: "corrected-result", result: { diameter: "4" } }],
  });
  expect(corrected.data.items[0].status, JSON.stringify(corrected)).toBe("applied");
  const history = await admin(`/tasks/${f.tasks[0].task_uid}/attempts`);
  expect(history.data.attempts).toHaveLength(1);
  expect(history.data.attempts[0].result).toEqual({ diameter: "4" });
});
test("a blank result pointer validates the whole result against the integer column", async () => {
  const f = await fixture(1, "integer", "");
  const grant = await compute(f.key, "/claim", { ...meta(), pool: f.slug, worker_id: "w" });
  const t = grant.data.tasks[0];
  const item = {
    item_id: "object-result",
    task_id: t.task_id,
    attempt_id: t.attempt_id,
    lease_token: t.lease_token,
    lease_generation: t.lease_generation,
    instance_epoch: t.instance_epoch,
    outcome: "success",
    result: { diameter: 4 },
    runtime_seconds: 0.0123456789,
    runtime_origin: "received",
  };
  const body = { ...meta(), pool: f.slug, worker_id: "w", items: [item] };
  const rejected = await compute(f.key, "/report", body);
  expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
  expect(rejected.data.items[0]).toMatchObject({
    status: "rejected",
    error: { code: "INVALID_VALUE", message: "Diameter requires an integer." },
  });
  const corrected = await compute(f.key, "/report", {
    ...body,
    ...meta(),
    items: [{ ...item, item_id: "scalar-result", result: 4 }],
  });
  expect(corrected.data.items[0].status, JSON.stringify(corrected)).toBe("applied");
  const rows = await admin(`/pools/${f.pool}/tasks`);
  expect(rows.data.rows[0].result).toEqual({ diameter: 4 });
});
test("DB-01/DB-02: concurrent claims and identical requests grant once", async () => {
  const f = await fixture(5),
    same = { ...meta(), pool: f.slug, worker_id: "same", count: 2 };
  const duplicates = await Promise.all(
    Array.from({ length: 5 }, () => compute(f.key, "/claim", same)),
  );
  for (const d of duplicates) {
    expect(d.ok, JSON.stringify(d)).toBe(true);
    expect(d.data).toEqual(duplicates[0].data);
  }
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      compute(f.key, "/claim", {
        ...meta(),
        pool: f.slug,
        worker_id: `w${i}`,
        count: 1,
      }),
    ),
  );
  const tasks = results.flatMap((r) => {
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.data.tasks;
  });
  expect(new Set(tasks.map((t) => t.task_id)).size).toBe(tasks.length);
  expect(tasks.length).toBe(3);
});
test("UI-03/UI-05/UI-07: revisions, active inputs, and harmless notes", async () => {
  const f = await fixture(),
    uid = f.tasks[0].task_uid;
  const a = await admin(
    `/tasks/${uid}`,
    {
      ...meta(),
      expected_edit_revision: 1,
      expected_input_revision: 1,
      patch: { data: { n: 5 } },
    },
    "PATCH",
  );
  expect(a.ok, JSON.stringify(a)).toBe(true);
  const conflict = await admin(
    `/tasks/${uid}`,
    { ...meta(), expected_edit_revision: 1, patch: { data: { n: 8 } } },
    "PATCH",
  );
  expect(conflict.error.code).toBe("EDIT_CONFLICT");
  expect(conflict.error.details.current.data.n).toBe(5);
  const claim = await compute(f.key, "/claim", {
    ...meta(),
    pool: f.slug,
    worker_id: "worker",
  });
  expect(claim.data.tasks[0].data.n).toBe(5);
  const leased = await admin(
    `/tasks/${uid}`,
    { ...meta(), expected_edit_revision: 2, patch: { data: { n: 7 } } },
    "PATCH",
  );
  expect(leased.error.code).toBe("TASK_LEASED");
  const note = await admin(
    `/tasks/${uid}`,
    { ...meta(), expected_edit_revision: 2, patch: { admin_note: "running" } },
    "PATCH",
  );
  expect(note.ok, JSON.stringify(note)).toBe(true);
});
test("DB-03/DB-04 and lease outcomes preserve attempts and global completion", async () => {
  const f = await fixture(0),
    empty = { ...meta(), pool: f.slug, worker_id: "w", count: 1 };
  expect((await compute(f.key, "/claim", empty)).data.tasks).toHaveLength(0);
  await admin(`/pools/${f.pool}/tasks`, { ...meta(), data: { n: 1 } });
  expect((await compute(f.key, "/claim", empty)).data.tasks).toHaveLength(0);
  const conflict = await compute(f.key, "/claim", { ...empty, count: 2 });
  expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
  const grant = await compute(f.key, "/claim", {
      ...meta(),
      pool: f.slug,
      worker_id: "w",
    }),
    t = grant.data.tasks[0];
  const identity = {
    item_id: "i",
    task_id: t.task_id,
    attempt_id: t.attempt_id,
    lease_token: t.lease_token,
    lease_generation: t.lease_generation,
    instance_epoch: t.instance_epoch,
  };
  const release = await compute(f.key, "/report", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
    items: [
      {
        ...identity,
        outcome: "release",
        message: "retry",
        details: { why: "transient" },
      },
    ],
  });
  expect(release.data.items[0].status, JSON.stringify(release)).toBe("applied");
  const next = await compute(f.key, "/claim", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
  });
  expect(next.data.tasks[0].attempts).toBe(2);
  expect(next.data.tasks[0].lease_generation).toBeGreaterThan(t.lease_generation);
  const changed = await compute(f.key, "/report", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
    items: [{ ...identity, outcome: "success", result: { diameter: 1 } }],
  });
  expect(changed.data.items[0].error.code).toBe("RESULT_CONFLICT");
});
test("LEASE-04/05/06/09: expiry, mixed batches and late success", async () => {
  const f = await fixture(2),
    grant = await compute(f.key, "/claim", {
      ...meta(),
      pool: f.slug,
      worker_id: "w",
      count: 2,
    }),
    [a, b] = grant.data.tasks;
  const item = (t: any) => ({
    item_id: t.task_id,
    task_id: t.task_id,
    attempt_id: t.attempt_id,
    lease_token: t.lease_token,
    lease_generation: t.lease_generation,
    instance_epoch: t.instance_epoch,
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE attempts SET expires_at=? WHERE id=?").bind(
      Date.now() - 1000,
      a.attempt_id,
    ),
    env.DB.prepare("UPDATE lease_heads SET expires_at=? WHERE attempt_id=?").bind(
      Date.now() - 1000,
      a.attempt_id,
    ),
  ]);
  const renew = await compute(f.key, "/renew", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
    items: [
      { ...item(a), lease_seconds: 7200 },
      { ...item(b), lease_seconds: 7200 },
    ],
  });
  expect(renew.data.items[0].error.code).toBe("LEASE_EXPIRED");
  expect(renew.data.items[1].status).toBe("applied");
  const report = await compute(f.key, "/report", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
    items: [
      { ...item(a), outcome: "success", result: { diameter: 0 } },
      { bad: "item" },
      { ...item(b), outcome: "permanent_failure", message: "unsupported" },
    ],
  });
  expect(report.ok, JSON.stringify(report)).toBe(true);
  expect(report.data.items.map((i: any) => i.status)).toEqual(["applied", "rejected", "applied"]);
  expect(report.data.items[0].late).toBe(true);
  const history = await admin(`/tasks/${f.tasks[0].task_uid}/attempts`);
  expect(history.data.attempts[0].input).toEqual({ n: 0 });
  expect(history.data.attempts[0].result).toEqual({ diameter: 0 });
  expect(JSON.stringify(history)).not.toContain(a.lease_token);
});
test("UI-15/LEASE-11: frozen reset preview conflicts and lifetime fences survive full reset", async () => {
  const f = await fixture(2),
    preview = await admin("/tasks/bulk/preview", {
      ...meta(),
      pool_id: f.pool,
      selection: { ids: f.tasks.map((t) => t.task_uid) },
      action: { kind: "reset", mode: "full", scope: "all", revoke: true },
    });
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  const grant = await compute(f.key, "/claim", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
    count: 1,
  });
  expect(grant.ok).toBe(true);
  const applied = await admin(`/operations/${preview.data.operation_id}/apply`, {
    ...meta(),
    limit: 50,
  });
  expect(applied.ok, JSON.stringify(applied)).toBe(true);
  expect(applied.data.items.filter((i: any) => i.status === "rejected")).toHaveLength(1);
  const renewed = await admin("/tasks/bulk/preview", {
    ...meta(),
    pool_id: f.pool,
    selection: { ids: f.tasks.map((t) => t.task_uid) },
    action: { kind: "reset", mode: "full", scope: "all", revoke: true },
  });
  const reset = await admin(`/operations/${renewed.data.operation_id}/apply`, {
    ...meta(),
    limit: 50,
  });
  expect(reset.ok, JSON.stringify(reset)).toBe(true);
  expect(reset.data.items.every((i: any) => i.status === "applied")).toBe(true);
  const next = await compute(f.key, "/claim", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
    count: 2,
  });
  expect(next.data.tasks.every((t: any) => t.attempts_total === 1)).toBe(true);
  expect(
    next.data.tasks.find((t: any) => t.task_id === grant.data.tasks[0].task_id).lease_generation,
  ).toBeGreaterThan(grant.data.tasks[0].lease_generation);
});
test("UI-09/UI-10: idempotent import chunks and complete export selection", async () => {
  const f = await fixture(0),
    preview = await admin("/imports/preview", {
      ...meta(),
      pool_id: f.pool,
      mode: "add",
      total: 3,
    });
  const id = preview.data.operation_id;
  const chunk = {
    ...meta(),
    start: 0,
    rows: [
      { task_id: "a", data: { n: 1 } },
      { task_id: "b", data: { n: 2 } },
      { task_id: "c", data: { n: 3 } },
    ],
  };
  expect((await admin(`/imports/${id}/preview-chunks`, chunk)).ok).toBe(true);
  expect((await admin(`/imports/${id}/preview-chunks`, chunk)).ok).toBe(true);
  const apply = { ...meta(), limit: 50 };
  const first = await admin(`/imports/${id}/chunks`, apply);
  expect(first.ok, JSON.stringify(first)).toBe(true);
  expect(first.data.items).toHaveLength(3);
  expect((await admin(`/imports/${id}/chunks`, apply)).data.items).toEqual(first.data.items);
  const exported = await admin("/exports", {
    ...meta(),
    pool_id: f.pool,
    selection: { filter: "n >= 2" },
  });
  const page = await admin(`/exports/${exported.data.operation_id}/pages`);
  expect(page.ok, JSON.stringify(page)).toBe(true);
  expect(page.data.rows.map((r: any) => r.task_id)).toEqual(["b", "c"]);
});
test("AUTH-04/05/06: key creation receipts redact secrets and revocation fences work", async () => {
  const f = await fixture(),
    body = { ...meta(), family_id: f.family, label: "one-time" },
    key = await admin("/keys", body),
    replay = await admin("/keys", body);
  expect(key.data.secret_available).toBe(true);
  expect(replay.data.secret_available).toBe(false);
  expect(replay.data.key).toBeUndefined();
  const grant = await compute(f.key, "/claim", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
  });
  await admin(`/keys/${f.keyId}/soft-revoke`, {
    ...meta(),
    reason: "rotation",
  });
  expect(
    (
      await compute(f.key, "/claim", {
        ...meta(),
        pool: f.slug,
        worker_id: "w",
      })
    ).error.code,
  ).toBe("KEY_REVOKED");
  expect(
    (await compute(f.key, "/recover", { pool: f.slug, worker_id: "w" })).data.tasks,
  ).toHaveLength(1);
  await admin(`/keys/${f.keyId}/hard-revoke`, {
    ...meta(),
    reason: "compromised",
  });
  expect((await compute(f.key, "/recover", { pool: f.slug, worker_id: "w" })).error.code).toBe(
    "KEY_REVOKED",
  );
  const next = await compute(key.data.key, "/claim", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
  });
  expect(next.data.tasks).toHaveLength(1);
  expect(next.data.tasks[0].lease_generation).toBeGreaterThan(grant.data.tasks[0].lease_generation);
});
test("DB-08/DB-09: shared pools and family caps are counted atomically", async () => {
  const f = await fixture(5),
    family = await admin("/families", {
      ...meta(),
      slug: `other-${crypto.randomUUID().slice(0, 8)}`,
      name: "Other family",
      policy: { family_cap: 1 },
    });
  const otherSlug = (await admin(`/families/${family.data.id}`)).data.slug;
  const profile = await admin("/profiles", {
    ...meta(),
    family_id: family.data.id,
    pool_id: f.pool,
    slug: "shared",
    name: "Shared",
  });
  expect(profile.ok, JSON.stringify(profile)).toBe(true);
  const key = await admin("/keys", {
    ...meta(),
    family_id: family.data.id,
    label: "Other key",
  });
  await admin(
    `/pools/${f.pool}`,
    { ...meta(), expected_revision: 1, patch: { active_cap: 2 } },
    "PATCH",
  );
  const [a, b] = await Promise.all([
    compute(f.key, "/claim", {
      ...meta(),
      pool: f.slug,
      worker_id: "w",
      count: 1,
    }),
    compute(key.data.key, "/claim", {
      ...meta(),
      pool: `${otherSlug}/shared`,
      worker_id: "other",
      count: 3,
    }),
  ]);
  expect(a.data.tasks).toHaveLength(1);
  expect(b.data.tasks).toHaveLength(1);
  expect(a.data.tasks[0].task_id).not.toBe(b.data.tasks[0].task_id);
  const capped = await compute(f.key, "/claim", {
    ...meta(),
    pool: f.slug,
    worker_id: "third",
    count: 3,
  });
  expect(capped.data.tasks).toHaveLength(0);
  expect(capped.data.limiting_reasons).toContain("POOL_CAP");
});
test("schema changes: optional columns preserve eligibility; incompatible changes resume", async () => {
  const f = await fixture(),
    current = (await admin(`/pools/${f.pool}/fields`)).data.fields;
  const optional = [
    ...current,
    {
      key: "label",
      label: "Label",
      type: "string",
      kind: "input",
      nullable: true,
      required: false,
      position: 2,
      active: true,
    },
  ];
  const preview = await admin(`/pools/${f.pool}/fields/preview`, {
    ...meta(),
    expected_revision: 1,
    fields: optional,
  });
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  expect(preview.data.incompatible).toBe(false);
  const applied = await admin(`/pools/${f.pool}/fields/apply`, {
    ...meta(),
    operation_id: preview.data.operation_id,
  });
  expect(applied.ok, JSON.stringify(applied)).toBe(true);
  const claimed = await compute(f.key, "/claim", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
  });
  expect(claimed.data.tasks).toHaveLength(1);
  const pool = (await admin(`/pools/${f.pool}`)).data,
    newFields = (await admin(`/pools/${f.pool}/fields`)).data.fields.map((x: any) =>
      x.key === "n" ? { ...x, key: "size", label: "Size" } : x,
    );
  const p2 = await admin(`/pools/${f.pool}/fields/preview`, {
    ...meta(),
    expected_revision: pool.config_revision,
    fields: newFields,
  });
  expect(p2.ok).toBe(true);
  const blocked = await admin(`/pools/${f.pool}/fields/apply`, {
    ...meta(),
    operation_id: p2.data.operation_id,
  });
  expect(blocked.error.code).toBe("CONFIG_CHANGED");
  let result = await admin(`/pools/${f.pool}/fields/apply`, {
    ...meta(),
    operation_id: p2.data.operation_id,
    revoke: true,
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const drain = await compute(f.key, "/claim", {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
  });
  expect(drain.data.tasks).toHaveLength(0);
  for (let i = 0; i < 4 && result.data.status === "migrating"; i++)
    result = await admin(`/pools/${f.pool}/fields/apply`, {
      ...meta(),
      operation_id: p2.data.operation_id,
      revoke: true,
    });
  expect(result.data.status, JSON.stringify(result)).toBe("complete");
  const task = (await admin(`/tasks/${f.tasks[0].task_uid}`)).data.task;
  expect(task.data).toEqual({ size: 0 });
});
test("AUTH-01/02/07: alternate routes, forged headers and origin restrictions fail closed", async () => {
  const wrong = await SELF.fetch("https://untrusted.example/admin-api/v1/me");
  expect(wrong.status).toBe(403);
  const csrf = await SELF.fetch("http://127.0.0.1:8787/admin-api/v1/families", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
      "X-Task-Broker": "1",
    },
    body: JSON.stringify({ ...meta(), name: "bad", slug: "bad" }),
  });
  expect(csrf.status).toBe(403);
  const missing = await SELF.fetch("http://127.0.0.1:8787/api/v1/unknown", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(missing.status).toBe(401);
  expect(missing.headers.get("Content-Type")).toContain("application/json");
});

test("DB-05: a failure after attempt insertion rolls back receipts, counters and history", async () => {
  const f = await fixture();
  const before = await env.DB.prepare("SELECT count(*) n FROM requests").first<any>();
  await env.DB.prepare(
    `CREATE TRIGGER test_rollback BEFORE UPDATE ON tasks WHEN NEW.task_uid='${f.tasks[0].task_uid}' AND NEW.lifetime_attempts>OLD.lifetime_attempts BEGIN SELECT RAISE(ABORT,'injected verification failure'); END`,
  ).run();
  const body = { ...meta(), pool: f.slug, worker_id: "rollback" };
  try {
    const failed = await compute(f.key, "/claim", body);
    expect(failed.status).toBe(500);
    expect((await env.DB.prepare("SELECT count(*) n FROM requests").first<any>()).n).toBe(before.n);
    expect(
      (
        await env.DB.prepare("SELECT count(*) n FROM attempts WHERE task_uid=?")
          .bind(f.tasks[0].task_uid)
          .first<any>()
      ).n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT lifetime_attempts FROM tasks WHERE task_uid=?")
          .bind(f.tasks[0].task_uid)
          .first<any>()
      ).lifetime_attempts,
    ).toBe(0);
  } finally {
    await env.DB.prepare("DROP TRIGGER test_rollback").run();
  }
  expect((await compute(f.key, "/claim", body)).data.tasks).toHaveLength(1);
});

test("UI-15: simultaneous duplicate chunks consume frozen operation items once", async () => {
  const f = await fixture();
  const op = await admin("/tasks/bulk/preview", {
    ...meta(),
    pool_id: f.pool,
    selection: { ids: [f.tasks[0].task_uid] },
    action: { kind: "duplicate" },
  });
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      admin(`/operations/${op.data.operation_id}/apply`, { ...meta(), limit: 50 }),
    ),
  );
  expect(results.some((r) => r.ok)).toBe(true);
  expect((await admin(`/pools/${f.pool}/tasks`)).data.total).toBe(2);
});

test("OPS-02: tasks created after a schema preview require a fresh review", async () => {
  const f = await fixture();
  const fields = (await admin(`/pools/${f.pool}/fields`)).data.fields.map((x: any) =>
    x.key === "n" ? { ...x, key: "size", label: "Size" } : x,
  );
  const op = await admin(`/pools/${f.pool}/fields/preview`, {
    ...meta(),
    expected_revision: 1,
    fields,
  });
  await admin(`/pools/${f.pool}/tasks`, { ...meta(), data: { n: 9 } });
  const applied = await admin(`/pools/${f.pool}/fields/apply`, {
    ...meta(),
    operation_id: op.data.operation_id,
    revoke: true,
  });
  expect(applied.error.code).toBe("CONFIG_CHANGED");
  expect((await admin(`/pools/${f.pool}`)).data.migration_status).toBe("ready");
});

test("AUTH-04/OPS-03: replay checks the live epoch and soft-revocation expiry", async () => {
  const f = await fixture();
  const claim = { ...meta(), pool: f.slug, worker_id: "w" };
  const task = (await compute(f.key, "/claim", claim)).data.tasks[0];
  const report = {
    ...meta(),
    pool: f.slug,
    worker_id: "w",
    items: [
      {
        item_id: "report",
        task_id: task.task_id,
        attempt_id: task.attempt_id,
        lease_token: task.lease_token,
        lease_generation: task.lease_generation,
        instance_epoch: task.instance_epoch,
        outcome: "release",
      },
    ],
  };
  expect((await compute(f.key, "/report", report)).ok).toBe(true);
  await env.DB.prepare("UPDATE api_keys SET status='soft_revoked' WHERE id=?").bind(f.keyId).run();
  expect((await compute(f.key, "/report", report)).ok).toBe(true);
  await env.DB.prepare("UPDATE attempts SET expires_at=0 WHERE id=?").bind(task.attempt_id).run();
  expect((await compute(f.key, "/report", report)).error.code).toBe("KEY_REVOKED");
  await env.DB.prepare("UPDATE api_keys SET status='active' WHERE id=?").bind(f.keyId).run();
  const old = await env.DB.prepare("SELECT active_epoch FROM installation WHERE id=1").first<any>();
  await env.DB.prepare("UPDATE installation SET active_epoch='restored-epoch' WHERE id=1").run();
  try {
    expect((await compute(f.key, "/claim", claim)).error.code).toBe("INSTANCE_CHANGED");
  } finally {
    await env.DB.prepare("UPDATE installation SET active_epoch=? WHERE id=1")
      .bind(old.active_epoch)
      .run();
  }
});

test("OPS-06: reviewed legacy migration preserves IDs and results with explicit provenance", async () => {
  const f = await fixture(0);
  const disabled = await admin(
    `/pools/${f.pool}`,
    { ...meta(), expected_revision: 1, patch: { enabled: false } },
    "PATCH",
  );
  expect(disabled.ok).toBe(true);
  const op = await admin("/imports/preview", {
    ...meta(),
    pool_id: f.pool,
    mode: "legacy",
    total: 1,
  });
  expect(op.ok, JSON.stringify(op)).toBe(true);
  const chunk = await admin(`/imports/${op.data.operation_id}/preview-chunks`, {
    ...meta(),
    start: 0,
    rows: [
      {
        task_id: "original-001",
        data: { n: "9007199254740993" },
        legacy_result: { diameter: 9 },
        legacy_completed: true,
        legacy_attempts: 3,
      },
    ],
  });
  expect(chunk.ok, JSON.stringify(chunk)).toBe(true);
  const applied = await admin(`/imports/${op.data.operation_id}/chunks`, { ...meta(), limit: 50 });
  expect(applied.data.items[0].status, JSON.stringify(applied)).toBe("applied");
  expect(
    (await admin(`/imports/${op.data.operation_id}/chunks`, { ...meta(), limit: 50 })).data.items,
  ).toEqual([]);
  const row = (await admin(`/pools/${f.pool}/tasks`)).data.rows[0];
  expect(row.task_id).toBe("original-001");
  expect(row.data.n).toBe("9007199254740993");
  expect(row.result).toEqual({ diameter: 9 });
  expect(row.attempts_total).toBe(3);
  const history = (await admin(`/tasks/${row.task_uid}/attempts`)).data;
  expect(history.attempts).toHaveLength(0);
  expect(history.imported_history.historical_attempts).toBe(3);
  const renamed = await admin(
    `/tasks/${row.task_uid}`,
    { ...meta(), expected_edit_revision: row.edit_revision, patch: { task_id: "renamed" } },
    "PATCH",
  );
  expect(renamed.error.code).toBe("EDIT_CONFLICT");
});

test("OPS-04: bounded receipt pruning retains permanent task and attempt history", async () => {
  const f = await fixture();
  const body = { ...meta(), pool: f.slug, worker_id: "prune" };
  const task = (await compute(f.key, "/claim", body)).data.tasks[0];
  await env.DB.prepare("UPDATE requests SET retention_deadline=0 WHERE request_id=?")
    .bind(body.request_id)
    .run();
  expect((await admin("/maintenance/prune", meta())).ok).toBe(true);
  expect(
    await env.DB.prepare("SELECT uid FROM requests WHERE request_id=?")
      .bind(body.request_id)
      .first(),
  ).toBeNull();
  const stored = await env.DB.prepare("SELECT id FROM attempts WHERE id=?")
    .bind(task.attempt_id)
    .first();
  expect(stored).not.toBeNull();
  expect((await admin(`/tasks/${f.tasks[0].task_uid}/attempts`)).data.attempts).toHaveLength(1);
});

test("UI-08/UI-15: frozen per-row patches reject competing revisions and preserve exact integers", async () => {
  const f = await fixture(2);
  const op = await admin("/tasks/bulk/patches/preview", {
    ...meta(),
    pool_id: f.pool,
    rows: f.tasks.map((t: any, i: number) => ({
      task_uid: t.task_uid,
      expected_edit_revision: 1,
      patch: { data: { n: i === 0 ? "9007199254740993" : 8 } },
    })),
  });
  expect(op.ok, JSON.stringify(op)).toBe(true);
  await admin(
    `/tasks/${f.tasks[1].task_uid}`,
    { ...meta(), expected_edit_revision: 1, patch: { admin_note: "concurrent" } },
    "PATCH",
  );
  const applied = await admin(`/operations/${op.data.operation_id}/apply`, {
    ...meta(),
    limit: 50,
  });
  expect(applied.data.items.map((i: any) => i.status)).toEqual(["applied", "rejected"]);
  expect((await admin(`/tasks/${f.tasks[0].task_uid}`)).data.task.data.n).toBe("9007199254740993");
});

test("UI-09/UI-15: invalid import rows count toward terminal progress without blocking valid rows", async () => {
  const f = await fixture(0);
  const op = (
    await admin("/imports/preview", { ...meta(), pool_id: f.pool, mode: "add", total: 2 })
  ).data.operation_id;
  await admin(`/imports/${op}/preview-chunks`, {
    ...meta(),
    start: 0,
    rows: [
      { task_id: "bad", data: { n: "no integer" } },
      { task_id: "valid", data: { n: 3 } },
    ],
  });
  expect((await admin(`/operations/${op}`)).data.processed).toBe(1);
  const applied = await admin(`/imports/${op}/chunks`, { ...meta(), limit: 50 });
  expect(applied.data.items).toHaveLength(1);
  const status = (await admin(`/operations/${op}`)).data;
  expect(status.status).toBe("complete");
  expect(status.processed).toBe(2);
  expect(status.counts).toEqual(
    expect.arrayContaining([
      { status: "applied", count: 1 },
      { status: "rejected", count: 1 },
    ]),
  );
});

test("UI-12: bounded metadata cursors bind filters and sorting and omit key secrets", async () => {
  const f = await fixture(0);
  await admin("/keys", { ...meta(), family_id: f.family, label: "second" });
  const first = (await admin(`/keys?family_id=${f.family}&limit=1&sort=label&direction=asc`)).data;
  expect(first.rows).toHaveLength(1);
  expect(first.rows[0].label).toBe("second");
  expect(first.rows[0].issued_at).toMatch(/Z$/);
  expect(first.rows[0]).not.toHaveProperty("secret_digest");
  expect(first.cursor).toBeTruthy();
  const next = await admin(
    `/keys?family_id=${f.family}&limit=1&sort=label&direction=asc&cursor=${encodeURIComponent(first.cursor)}`,
  );
  expect(next.data.rows[0].label).toBe("test");
  expect(next.data.cursor).toBeNull();
  const changed = await admin(
    `/keys?family_id=${f.family}&limit=1&sort=label&direction=desc&cursor=${encodeURIComponent(first.cursor)}`,
  );
  expect(changed.ok).toBe(false);
});

test("FILTER-04/FILTER-05/AUTH-03: mandatory filters and hidden-input allowlists cannot widen family authority", async () => {
  const f = await fixture(6);
  const profile = await admin("/profiles", {
    ...meta(),
    family_id: f.family,
    pool_id: f.pool,
    slug: "restricted",
    name: "Restricted",
    mandatory_filter: "n < 3",
    projection: [],
    filter_allowlist: [],
  });
  expect(profile.ok, JSON.stringify(profile)).toBe(true);
  const denied = await compute(f.key, "/claim", {
    ...meta(),
    pool: `${f.slug}/restricted`,
    worker_id: "w",
    filter: "n = 1 OR n = 5",
  });
  expect(denied.ok).toBe(false);
  const config = await admin(
    `/profiles/${profile.data.id}`,
    { ...meta(), expected_revision: 1, patch: { filter_allowlist: ["n"] } },
    "PATCH",
  );
  expect(config.ok, JSON.stringify(config)).toBe(true);
  const claim = await compute(f.key, "/claim", {
    ...meta(),
    pool: `${f.slug}/restricted`,
    worker_id: "w",
    count: 20,
    filter: "n = 1 OR n = 5",
  });
  expect(claim.ok, JSON.stringify(claim)).toBe(true);
  expect(claim.data.tasks).toHaveLength(1);
  expect(claim.data.tasks[0].task_id).toBe("task-1");
  expect(claim.data.tasks[0].data).toEqual({});
  const other = await fixture(0);
  const forbidden = await compute(other.key, "/claim", {
    ...meta(),
    pool: `${f.slug}/restricted`,
    worker_id: "w",
  });
  expect(forbidden.ok).toBe(false);
});

test("DB-07/DB-09: canonical retries share receipts and lowering a cap drains existing grants", async () => {
  const f = await fixture(5),
    profile = (await admin(`/profiles/${f.profile}`)).data;
  const body = { ...meta(), pool: f.slug, worker_id: "w", count: 3 };
  const first = await compute(f.key, "/claim", body);
  expect(first.data.tasks).toHaveLength(3);
  const replay = await compute(f.key, "/claim", { ...body, pool: `${f.slug}/${profile.slug}` });
  expect(replay.data.tasks).toEqual(first.data.tasks);
  const changed = await admin(
    `/profiles/${f.profile}`,
    { ...meta(), expected_revision: 1, patch: { policy: { profile_cap: 1 } } },
    "PATCH",
  );
  expect(changed.ok, JSON.stringify(changed)).toBe(true);
  expect(
    (await compute(f.key, "/claim", { ...meta(), pool: f.slug, worker_id: "new", count: 1 })).data
      .tasks,
  ).toHaveLength(0);
  expect(
    (await compute(f.key, "/recover", { pool: f.slug, worker_id: "w" })).data.tasks,
  ).toHaveLength(3);
});

test("FILTER-01/UI-10: signed pages sort decimal integers exactly across int64 limits", async () => {
  const f = await fixture(0),
    values = [
      "-9223372036854775809",
      "-9007199254740993",
      -10,
      -2,
      0,
      2,
      10,
      "9007199254740993",
      "9223372036854775809",
    ];
  for (let i = 0; i < values.length; i++)
    await admin(`/pools/${f.pool}/tasks`, {
      ...meta(),
      task_id: `number-${i}`,
      data: { n: values[i] },
    });
  for (const direction of ["asc", "desc"]) {
    const got: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = await admin(
        `/pools/${f.pool}/tasks?sort=n&direction=${direction}&limit=2${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      expect(page.ok, JSON.stringify(page)).toBe(true);
      got.push(...page.data.rows.map((r: any) => r.data.n));
      cursor = page.data.cursor;
    } while (cursor);
    expect(got).toEqual(direction === "asc" ? values : [...values].reverse());
  }
});

test("LEASE-01/LEASE-02/LEASE-12: profile failure remains local while profile reset preserves global success", async () => {
  const f = await fixture(2);
  await admin("/profiles", {
    ...meta(),
    family_id: f.family,
    pool_id: f.pool,
    slug: "second",
    name: "Second profile",
  });
  const grants = (
    await compute(f.key, "/claim", { ...meta(), pool: f.slug, worker_id: "first", count: 2 })
  ).data.tasks;
  const identity = (t: any) => ({
    item_id: t.task_id,
    task_id: t.task_id,
    attempt_id: t.attempt_id,
    lease_token: t.lease_token,
    lease_generation: t.lease_generation,
    instance_epoch: t.instance_epoch,
  });
  const result = {
    diameter: 0,
    metrics: { description: "x".repeat(10240), blank: null, enabled: false },
  };
  const outcomes = await compute(f.key, "/report", {
    ...meta(),
    pool: f.slug,
    worker_id: "first",
    items: [
      { ...identity(grants[0]), outcome: "permanent_failure", message: "Unsupported here" },
      { ...identity(grants[1]), outcome: "success", result },
    ],
  });
  expect(outcomes.data.items.map((i: any) => i.status)).toEqual(["applied", "applied"]);
  const second = await compute(f.key, "/claim", {
    ...meta(),
    pool: `${f.slug}/second`,
    worker_id: "second",
    count: 2,
  });
  expect(second.data.tasks).toHaveLength(1);
  expect(second.data.tasks[0].task_id).toBe(grants[0].task_id);
  const completed = f.tasks.find((t: any) => t.task_id === grants[1].task_id)!;
  const preview = await admin("/tasks/bulk/preview", {
    ...meta(),
    pool_id: f.pool,
    profile_id: f.profile,
    selection: { ids: [completed.task_uid] },
    action: { kind: "reset", mode: "full", scope: "profile" },
  });
  expect(preview.ok, JSON.stringify(preview)).toBe(true);
  expect(
    (await admin(`/operations/${preview.data.operation_id}/apply`, { ...meta(), limit: 50 })).data
      .items[0].status,
  ).toBe("applied");
  const row = (await admin(`/tasks/${completed.task_uid}`)).data.task;
  expect(row.status).toBe("completed");
  expect(row.result).toEqual({ diameter: 0 });
  expect((await admin(`/tasks/${completed.task_uid}/attempts`)).data.attempts[0].result).toEqual(
    result,
  );
});
