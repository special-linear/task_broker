import { mkdir } from "node:fs/promises";
await mkdir("artifacts/private/verification", { recursive: true });
import { loadWranglerConfig } from "./wrangler-config.ts";
import { randomUUID } from "node:crypto";
import { accessToken } from "./access-session.mjs";
export const config = (await loadWranglerConfig()).env.staging;
export const origin = process.env.TEST_ORIGIN ?? config.vars.ADMIN_ORIGIN;
const local = new URL(origin).hostname === "127.0.0.1";
const token = local ? "" : await accessToken(config.vars.ACCESS_AUDIENCE);
export const measurements = [];
export const meta = () => ({
  request_id: randomUUID(),
  request_created_at: new Date().toISOString(),
});
export async function request(path, body, { key, method } = {}) {
  const start = performance.now();
  const response = await fetch(origin + (key ? "/api/v1" : "/admin-api/v1") + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      ...(key
        ? { Authorization: `Bearer ${key}` }
        : {
            Origin: origin,
            "X-Task-Broker": "1",
            ...(token ? { Cookie: `CF_Authorization=${token}` } : {}),
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  const server = response.headers.get("server-timing") ?? "";
  const metric = (name) =>
    Number(
      new RegExp(`${name};(?:desc="([0-9.]+)"|dur=([0-9.]+))`)
        .exec(server)
        ?.slice(1)
        .find(Boolean) ?? 0,
    );
  measurements.push({
    path,
    status: response.status,
    ms: Math.round((performance.now() - start) * 100) / 100,
    statements: metric("queries"),
    max_parameters: metric("parameters"),
    storage_bytes: metric("storage"),
    rows_read: metric("reads"),
    rows_written: metric("writes"),
    sql_ms: metric("d1"),
  });
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(`HTTP ${response.status} non-JSON response for ${path}`);
  const result = await response.json();
  if (!result.ok) {
    const error = new Error(`${path}: ${result.error.code}: ${result.error.message}`);
    error.code = result.error.code;
    throw error;
  }
  return result.data;
}
export const admin = (path, body, method) => request(path, body, { method });
export const compute = (key, path, body) => request(path, body, { key });
export function summary(rows = measurements) {
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b),
    percentile = (q) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0;
  return {
    requests: rows.length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    p99_ms: percentile(0.99),
    rows_read: rows.reduce((n, r) => n + r.rows_read, 0),
    rows_written: rows.reduce((n, r) => n + r.rows_written, 0),
    max_statements: Math.max(0, ...rows.map((r) => r.statements)),
    max_parameters: Math.max(0, ...rows.map((r) => r.max_parameters ?? 0)),
    storage_bytes: Math.max(0, ...rows.map((r) => r.storage_bytes ?? 0)),
    sql_ms: rows.reduce((n, r) => n + r.sql_ms, 0),
  };
}
