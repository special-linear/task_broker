import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";

const meta = () => ({
  request_id: crypto.randomUUID(),
  request_created_at: new Date().toISOString(),
});
async function admin(path: string, body?: unknown, method = "POST") {
  const response = await SELF.fetch(`http://127.0.0.1:8787/admin-api/v1${path}`, {
    method: body === undefined ? "GET" : method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:8787",
      "X-Task-Broker": "1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, ...(await response.json<any>()) };
}
async function ok(path: string, body?: unknown, method = "POST") {
  const result = await admin(path, body, method);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.data;
}
async function compute(key: string, path: string, body: unknown) {
  const response = await SELF.fetch(`http://127.0.0.1:8787/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const result = await response.json<any>();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.data;
}
const fields = [{ key: "n", label: "n", type: "integer" }];
async function fixture() {
  const slug = `config-${crypto.randomUUID().slice(0, 8)}`;
  const family = await ok("/families", { ...meta(), slug, name: "Calculations" });
  const pool = await ok("/pools", {
    ...meta(),
    family_id: family.id,
    name: "SL(n,Z/mZ) diameters",
    profile_slug: "diameters",
    fields,
  });
  return { slug, family: family.id, pool: pool.id, profile: pool.profile_id };
}
async function patch(path: string, changes: unknown) {
  const current = await ok(path);
  return ok(
    path,
    { ...meta(), expected_revision: current.config_revision, patch: changes },
    "PATCH",
  );
}
const deleteBody = (review: any) => ({
  ...meta(),
  expected_revision: review.expected_revision,
  dependency_token: review.dependency_token,
});
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await ok("/bootstrap", meta());
});

test("chosen suffixes, default selection and display renames keep worker targets explicit", async () => {
  const f = await fixture();
  const second = await ok("/pools", {
    ...meta(),
    family_id: f.family,
    name: "Another pool",
    profile_slug: "Spectra",
    fields,
  });
  expect((await ok(`/profiles/${second.profile_id}`)).slug).toBe("spectra");
  expect((await ok(`/families/${f.family}`)).default_profile_id).toBe(f.profile);
  const duplicate = await admin("/pools", {
    ...meta(),
    family_id: f.family,
    name: "Duplicate",
    profile_slug: "DIAMETERS",
    fields,
  });
  expect(duplicate.ok).toBe(false);
  expect(duplicate.error.message).toMatch(/suffix/);
  expect((await ok(`/pools?family_id=${f.family}`)).rows).toHaveLength(2);
  expect(
    (
      await admin("/pools", {
        ...meta(),
        family_id: f.family,
        name: "Invalid",
        profile_slug: "a/b",
        fields,
      })
    ).ok,
  ).toBe(false);
  await patch(`/pools/${f.pool}`, { name: "Renamed pool" });
  await patch(`/profiles/${f.profile}`, { name: "Renamed workers" });
  expect((await ok(`/profiles/${f.profile}`)).slug).toBe("diameters");
  const key = await ok("/keys", { ...meta(), family_id: f.family, label: "Worker" });
  await ok(`/pools/${f.pool}/tasks`, { ...meta(), task_id: "diameter", data: { n: 1 } });
  await ok(`/pools/${second.id}/tasks`, { ...meta(), task_id: "spectrum", data: { n: 2 } });
  await patch(`/families/${f.family}`, { default_profile_id: second.profile_id });
  expect(
    (await compute(key.key, "/claim", { ...meta(), pool: f.slug, worker_id: "default" })).tasks[0]
      .task_id,
  ).toBe("spectrum");
  expect(
    (
      await compute(key.key, "/claim", {
        ...meta(),
        pool: `${f.slug}/diameters`,
        worker_id: "explicit",
      })
    ).tasks[0].task_id,
  ).toBe("diameter");
  const other = await fixture();
  const current = await ok(`/families/${f.family}`);
  expect(
    (
      await admin(
        `/families/${f.family}`,
        {
          ...meta(),
          expected_revision: current.config_revision,
          patch: { default_profile_id: other.profile },
        },
        "PATCH",
      )
    ).ok,
  ).toBe(false);
  await patch(`/families/${f.family}`, { default_profile_id: null });
  expect((await ok(`/families/${f.family}`)).default_profile_id).toBeNull();
});

test("empty pool deletion removes reviewed unused profiles, defaults, aliases and indexes, and replays", async () => {
  const f = await fixture();
  const other = await fixture();
  const shared = await ok("/profiles", {
    ...meta(),
    family_id: other.family,
    pool_id: f.pool,
    name: "Shared",
    slug: "shared",
  });
  await patch(`/families/${other.family}`, { default_profile_id: shared.id });
  await env.DB.prepare("INSERT INTO profile_aliases(route,profile_id) VALUES(?,?)")
    .bind(`${f.slug}/old`, f.profile)
    .run();
  const index = await ok(`/pools/${f.pool}/claim-sort-indexes`, {
    ...meta(),
    name: "Order",
    sorts: [{ field: "n", direction: "asc" }],
  });
  await ok(`/claim-sort-indexes/${index.id}/build`, { ...meta(), expected_revision: 1 });
  expect((await ok(`/families/${f.family}/removal`)).can_delete).toBe(false);
  const review = await ok(`/pools/${f.pool}/removal`);
  expect(review.can_delete).toBe(true);
  expect(review.profiles).toHaveLength(2);
  expect(review.defaults).toHaveLength(2);
  const body = deleteBody(review);
  const result = await ok(`/pools/${f.pool}`, body, "DELETE");
  expect(await ok(`/pools/${f.pool}`, body, "DELETE")).toEqual(result);
  expect((await admin(`/pools/${f.pool}`)).status).toBe(404);
  expect((await admin(`/profiles/${f.profile}`)).status).toBe(404);
  expect((await admin(`/profiles/${shared.id}`)).status).toBe(404);
  for (const family of [f.family, other.family])
    expect((await ok(`/families/${family}`)).default_profile_id).toBeNull();
  expect(
    await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name=?")
      .bind(`claim_sort_${index.id.replaceAll("-", "")}`)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT 1 FROM profile_aliases WHERE profile_id=?")
      .bind(f.profile)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT 1 FROM audit_events WHERE entity_id=? AND diff_json LIKE '%deleted%'",
    )
      .bind(f.pool)
      .first(),
  ).not.toBeNull();
  const familyReview = await ok(`/families/${f.family}/removal`);
  expect(familyReview.can_delete).toBe(true);
  await ok(`/families/${f.family}`, deleteBody(familyReview), "DELETE");
  expect((await admin(`/families/${f.family}`)).status).toBe(404);
});

test("task and attempt history prevent deletion; archived profiles drain and restore disabled", async () => {
  const f = await fixture();
  const key = await ok("/keys", { ...meta(), family_id: f.family, label: "Worker" });
  await ok(`/pools/${f.pool}/tasks`, { ...meta(), task_id: "one", data: { n: 1 } });
  const t = (await compute(key.key, "/claim", { ...meta(), pool: f.slug, worker_id: "worker" }))
    .tasks[0];
  for (const path of [`/profiles/${f.profile}`, `/pools/${f.pool}`]) {
    const review = await ok(`${path}/removal`);
    expect(review.can_delete).toBe(false);
    expect((await admin(path, deleteBody(review), "DELETE")).status).toBe(409);
  }
  for (const path of [`/profiles/${f.profile}`, `/pools/${f.pool}`, `/families/${f.family}`])
    await patch(path, { archived: true });
  expect(
    (await compute(key.key, "/claim", { ...meta(), pool: f.slug, worker_id: "another" })).tasks,
  ).toHaveLength(0);
  const report = await compute(key.key, "/report", {
    ...meta(),
    pool: f.slug,
    worker_id: "worker",
    items: [
      {
        item_id: "done",
        task_id: t.task_id,
        attempt_id: t.attempt_id,
        lease_token: t.lease_token,
        lease_generation: t.lease_generation,
        instance_epoch: t.instance_epoch,
        outcome: "success",
        result: { value: 1 },
      },
    ],
  });
  expect(report.items[0].status).toBe("applied");
  const profile = await ok(`/profiles/${f.profile}`);
  expect(profile.archived_at).toMatch(/Z$/);
  expect(
    (
      await admin(
        `/profiles/${f.profile}`,
        { ...meta(), expected_revision: profile.config_revision, patch: { enabled: true } },
        "PATCH",
      )
    ).ok,
  ).toBe(false);
  await patch(`/profiles/${f.profile}`, { archived: false });
  expect((await ok(`/profiles/${f.profile}`)).enabled).toBe(0);
  expect((await ok(`/profiles/${f.profile}/removal`)).can_delete).toBe(false);
  expect((await ok(`/pools/${f.pool}/tasks`)).rows[0].status).toBe("completed");
});

test("deletion rejects newly added dependencies and stale revisions without partial cleanup", async () => {
  const f = await fixture();
  const review = await ok(`/pools/${f.pool}/removal`);
  await ok("/profiles", {
    ...meta(),
    family_id: f.family,
    pool_id: f.pool,
    slug: "new",
    name: "New profile",
  });
  expect((await admin(`/pools/${f.pool}`, deleteBody(review), "DELETE")).error.code).toBe(
    "CONFIG_CHANGED",
  );
  expect((await ok(`/profiles?pool_id=${f.pool}`)).rows).toHaveLength(2);
  const reviewed = await ok(`/pools/${f.pool}/removal`);
  await patch(`/pools/${f.pool}`, { name: "Changed" });
  expect((await admin(`/pools/${f.pool}`, deleteBody(reviewed), "DELETE")).error.code).toBe(
    "CONFIG_CHANGED",
  );
  const finalReview = await ok(`/pools/${f.pool}/removal`);
  const results = await Promise.all([
    admin(`/pools/${f.pool}`, deleteBody(finalReview), "DELETE"),
    admin(`/pools/${f.pool}/tasks`, { ...meta(), task_id: "concurrent", data: { n: 1 } }),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  if (results[1].ok) {
    expect((await ok(`/pools/${f.pool}/tasks`)).rows).toHaveLength(1);
    expect((await ok(`/profiles?pool_id=${f.pool}`)).rows).toHaveLength(2);
  } else expect((await admin(`/pools/${f.pool}`)).status).toBe(404);
});

test("profile views and imported counters block removal, while unused profiles can be deleted", async () => {
  const f = await fixture();
  const profile = await ok("/profiles", {
    ...meta(),
    family_id: f.family,
    pool_id: f.pool,
    slug: "unused",
    name: "Unused",
  });
  const review = await ok(`/profiles/${profile.id}/removal`);
  await ok(`/profiles/${profile.id}`, deleteBody(review), "DELETE");
  expect((await ok(`/families/${f.family}`)).default_profile_id).toBe(f.profile);
  const task = await ok(`/pools/${f.pool}/tasks`, { ...meta(), task_id: "legacy", data: { n: 1 } });
  await env.DB.prepare(
    "INSERT INTO task_profile_state(task_uid,profile_id,attempts,lifetime_attempts) VALUES(?,?,2,2)",
  )
    .bind(task.task_uid, f.profile)
    .run();
  expect((await ok(`/profiles/${f.profile}/removal`)).reasons.join(" ")).toMatch(
    /imported history/,
  );
  const viewProfile = await ok("/profiles", {
    ...meta(),
    family_id: f.family,
    pool_id: f.pool,
    slug: "views",
    name: "Views",
  });
  await ok("/views", {
    ...meta(),
    pool_id: f.pool,
    profile_id: viewProfile.id,
    name: "Saved",
    presentation: {},
  });
  expect((await ok(`/profiles/${viewProfile.id}/removal`)).reasons.join(" ")).toMatch(
    /Saved views/,
  );
});

test("empty families require permanent key revocation before deletion", async () => {
  const f = await fixture();
  const key = await ok("/keys", { ...meta(), family_id: f.family, label: "Unused key" });
  await ok(`/pools/${f.pool}`, deleteBody(await ok(`/pools/${f.pool}/removal`)), "DELETE");
  expect((await ok(`/families/${f.family}/removal`)).can_delete).toBe(false);
  await ok(`/keys/${key.id}/hard-revoke`, { ...meta(), reason: "Delete unused family" });
  const review = await ok(`/families/${f.family}/removal`);
  expect(review.can_delete).toBe(true);
  expect(review.revoked_key_count).toBe(1);
  await ok(`/families/${f.family}`, deleteBody(review), "DELETE");
  expect(await env.DB.prepare("SELECT 1 FROM api_keys WHERE id=?").bind(key.id).first()).toBeNull();
});
