// Maintainer-only helper; never prints the OAuth token.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadWranglerConfig } from "./wrangler-config.ts";
const staging = (await loadWranglerConfig()).env.staging;
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? staging.account_id;
await mkdir("artifacts/private/verification", { recursive: true });
async function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const directory =
    process.env.WRANGLER_CREDENTIALS_DIRECTORY ??
    (process.env.APPDATA
      ? join(process.env.APPDATA, "xdg.config", ".wrangler", "config")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), ".wrangler", "config"));
  const p = join(directory, "default.toml");
  const config = await readFile(p, "utf8");
  const value = /^oauth_token\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  if (!value) throw new Error("No usable Wrangler OAuth token; run wrangler login.");
  return value;
}
const action = process.argv[2];
if (action === "save-local-secrets") {
  const { randomBytes, randomUUID } = await import("node:crypto");
  await mkdir("artifacts/private", { recursive: true });
  try {
    await readFile("artifacts/private/staging-secrets.json");
    console.log("Preserving existing staging secrets and epoch.");
  } catch {
    await writeFile(
      "artifacts/private/staging-secrets.json",
      JSON.stringify({
        INSTANCE_EPOCH: randomUUID(),
        APP_SIGNING_SECRET: randomBytes(32).toString("hex"),
      }),
      { mode: 0o600 },
    );
    console.log("Generated secrets in the ignored private artifact directory.");
  }
} else {
  const auth = await token(),
    base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  async function api(path, method = "GET", body) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, ...(await response.json()) };
  }
  if (action === "rollback-test") {
    const assert = (await import("node:assert/strict")).default;
    const { admin, compute, meta, measurements, summary, origin } =
      await import("./verification-api.mjs");
    const config = (await loadWranglerConfig()).env.staging;
    const query = async (sql, params = []) => {
      const r = await api(`/d1/database/${config.d1_databases[0].database_id}/query`, "POST", {
        sql,
        params,
      });
      assert(r.success, JSON.stringify(r.errors));
      return r.result[0].results;
    };
    const slug = `rollback-${crypto.randomUUID().slice(0, 8)}`,
      family = await admin("/families", {
        ...meta(),
        slug,
        name: "Remote transaction rollback verification",
      }),
      pool = await admin("/pools", {
        ...meta(),
        family_id: family.id,
        name: slug,
        fields: [{ key: "n", label: "n", type: "integer" }],
      }),
      task = await admin(`/pools/${pool.id}/tasks`, { ...meta(), data: { n: 3 } }),
      key = await admin("/keys", {
        ...meta(),
        family_id: family.id,
        label: "Disposable rollback verifier",
      });
    assert.match(task.task_uid, /^[a-f0-9-]{36}$/);
    const trigger = "verification_rollback_" + task.task_uid.replaceAll("-", "");
    const body = { ...meta(), pool: slug, worker_id: "rollback-proof" };
    await query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON tasks WHEN NEW.task_uid='${task.task_uid}' AND NEW.lifetime_attempts>OLD.lifetime_attempts BEGIN SELECT RAISE(ABORT,'injected verification failure'); END`,
    );
    try {
      await assert.rejects(compute(key.key, "/claim", body), { code: "INTERNAL_ERROR" });
      const counts = (
        await query(
          "SELECT (SELECT count(*) FROM requests WHERE request_id=?) receipts,(SELECT count(*) FROM attempts WHERE task_uid=?) attempts,(SELECT lifetime_attempts FROM tasks WHERE task_uid=?) lifetime_attempts",
          [body.request_id, task.task_uid, task.task_uid],
        )
      )[0];
      assert.deepEqual(counts, { receipts: 0, attempts: 0, lifetime_attempts: 0 });
    } finally {
      await query(`DROP TRIGGER ${trigger}`);
    }
    const granted = (await compute(key.key, "/claim", body)).tasks;
    assert.equal(granted.length, 1);
    await admin(`/keys/${key.id}/hard-revoke`, {
      ...meta(),
      reason: "Rollback verification complete",
    });
    const current = await admin(`/pools/${pool.id}`);
    await admin(
      `/pools/${pool.id}`,
      { ...meta(), expected_revision: current.config_revision, patch: { archived: true } },
      "PATCH",
    );
    await writeFile(
      "artifacts/private/verification/remote-rollback.json",
      JSON.stringify(
        {
          completed: true,
          recorded_at: new Date().toISOString(),
          origin,
          checks: [
            "target-scoped database trigger failed after attempt insert",
            "receipt, attempt and lifetime counter rolled back",
            "unchanged request succeeded after trigger removal",
            "verification key revoked and pool archived",
          ],
          summary: summary(),
          measurements,
        },
        null,
        2,
      ),
    );
    console.log("PASS real D1 failure-between-statements rollback and unchanged retry.");
  } else if (action === "recover-diagnose") {
    const config = (await loadWranglerConfig()).env.staging;
    const f = JSON.parse(await readFile("artifacts/private/performance-remote.json", "utf8"));
    const model = await readFile("src/worker/model.ts", "utf8");
    const sql = /const record = await one\(env.DB, `([\s\S]*?)`,\s*`/.exec(model)[1];
    const keyId = f.key.split("_")[1];
    const result = await api(`/d1/database/${config.d1_databases[0].database_id}/query`, "POST", {
      sql,
      params: [`key:${keyId}`, null, f.slug, f.slug, f.slug, null, f.slug, null],
    });
    console.log(
      JSON.stringify(
        {
          status: result.status,
          success: result.success,
          errors: result.errors,
          rows: result.result?.[0]?.results?.length,
        },
        null,
        2,
      ),
    );
  } else if (action === "plans") {
    const config = (await loadWranglerConfig()).env.staging;
    const fixture = JSON.parse(await readFile("artifacts/private/performance-remote.json", "utf8"));
    const queries = {
      fresh_candidates: {
        sql: "SELECT t.task_uid FROM tasks t WHERE t.pool_id=? AND t.deleted_at IS NULL AND t.enabled=1 AND t.completed_at IS NULL AND NOT EXISTS(SELECT 1 FROM task_profile_state ps WHERE ps.task_uid=t.task_uid AND ps.profile_id=?) ORDER BY t.task_id COLLATE BINARY,t.task_uid LIMIT 20",
        params: [fixture.pool, fixture.profile],
      },
      active_heads: {
        sql: "SELECT h.attempt_id FROM lease_heads h JOIN tasks t ON t.task_uid=h.task_uid AND t.latest_attempt_id=h.attempt_id AND t.lease_generation=h.lease_generation JOIN api_keys k ON k.id=h.issuing_key_id WHERE h.pool_id=? AND h.expires_at>? AND k.status!='hard_revoked'",
        params: [fixture.pool, Date.now()],
      },
      import_identity: {
        sql: "SELECT t.task_uid FROM task_identifiers ti JOIN tasks t ON t.task_uid=ti.task_uid WHERE ti.pool_id=? AND ti.public_id IN(SELECT value FROM json_each(?))",
        params: [fixture.pool, JSON.stringify(["task-000001", "task-009999"])],
      },
      pending_chunk: {
        sql: "SELECT ordinal,task_uid FROM admin_operation_items WHERE operation_id=? AND status='pending' ORDER BY ordinal LIMIT 50",
        params: [fixture.operation_id],
      },
    };
    const plans = { recorded_at: new Date().toISOString(), environment: "remote D1", queries: {} };
    for (const [name, q] of Object.entries(queries)) {
      const result = await api(`/d1/database/${config.d1_databases[0].database_id}/query`, "POST", {
        sql: "EXPLAIN QUERY PLAN " + q.sql,
        params: q.params,
      });
      if (!result.success) throw new Error(JSON.stringify(result.errors));
      plans.queries[name] = {
        sql: q.sql,
        parameter_count: q.params.length,
        plan: result.result[0].results,
      };
    }
    await writeFile(
      "artifacts/private/verification/sql-plans.json",
      JSON.stringify(plans, null, 2),
    );
    console.log(JSON.stringify(plans, null, 2));
  } else if (action === "metrics") {
    const since = process.env.METRICS_SINCE ?? new Date(Date.now() - 6 * 3600000).toISOString();
    const until = new Date().toISOString();
    const query = `query { viewer { accounts(filter:{accountTag:"${account}"}) { workersInvocationsAdaptive(limit:100,filter:{scriptName:"${staging.name}",datetime_geq:"${since}",datetime_leq:"${until}"}) { sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 } } } } }`;
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const result = {
      recorded_at: until,
      since,
      worker_settings: await api("/workers/account-settings"),
      subscriptions: await api("/subscriptions"),
      analytics: await response.json(),
    };
    await mkdir("artifacts/private/verification", { recursive: true });
    await writeFile(
      `artifacts/private/verification/cloudflare-usage${process.env.METRICS_LABEL ? "-" + process.env.METRICS_LABEL.replace(/[^a-z0-9-]/g, "") : ""}.json`,
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } else if (action === "access-check") {
    const result = await api("/access/apps");
    console.log(
      JSON.stringify(
        {
          status: result.status,
          success: result.success,
          errors: result.errors,
          applications: result.result?.map((a) => ({
            id: a.id,
            name: a.name,
            domain: a.domain,
            aud: a.aud,
            destinations: a.destinations,
          })),
        },
        null,
        2,
      ),
    );
  } else if (action === "access-create") {
    const host = new URL(staging.vars.ADMIN_ORIGIN).hostname;
    const body = {
      name: "Task Manager staging administration",
      type: "self_hosted",
      domain: `${host}/admin`,
      destinations: [
        { type: "public", uri: `${host}/admin` },
        { type: "public", uri: `${host}/admin-api` },
      ],
      session_duration: "24h",
      auto_redirect_to_identity: false,
      policies: [
        {
          name: "Staging owner",
          decision: "allow",
          include: staging.vars.OWNER_EMAILS.split(",").map((email) => ({
            email: { email: email.trim() },
          })),
        },
      ],
    };
    const result = await api("/access/apps", "POST", body);
    console.log(
      JSON.stringify(
        {
          status: result.status,
          success: result.success,
          errors: result.errors,
          id: result.result?.id,
          aud: result.result?.aud,
        },
        null,
        2,
      ),
    );
  } else
    throw new Error(
      "Expected rollback-test, plans, metrics, recover-diagnose, access-check, access-create, or save-local-secrets.",
    );
}
