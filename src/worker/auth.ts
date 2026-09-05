import { createRemoteJWKSet, jwtVerify } from "jose";
import { AppError, assert, sha256 } from "../shared/core";
import { one } from "./db";
import type { Actor, Env } from "./types";
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export function validateEnvironment(env: Env) {
  if (env.ENVIRONMENT === "local") {
    assert(
      env.DEV_AUTH === "true",
      "UNAUTHENTICATED",
      "Local authentication is not configured.",
      503,
    );
    return;
  }
  assert(
    !env.DEV_AUTH &&
      env.ACCESS_ISSUER &&
      env.ACCESS_AUDIENCE &&
      env.ACCESS_AUDIENCE !== "REPLACE-ME" &&
      env.OWNER_EMAILS &&
      env.INSTANCE_EPOCH &&
      !/replace-with|local-development/i.test(env.INSTANCE_EPOCH) &&
      env.APP_SIGNING_SECRET?.length >= 32 &&
      !/replace-with|local-only/i.test(env.APP_SIGNING_SECRET),
    "UNAUTHENTICATED",
    "Deployment authentication configuration is incomplete.",
    503,
  );
  assert(
    new URL(env.ADMIN_ORIGIN).protocol === "https:" &&
      new URL(env.ACCESS_ISSUER).protocol === "https:",
    "UNAUTHENTICATED",
    "Production origins must use HTTPS.",
    503,
  );
}
export function routeKind(request: Request, env: Env): "admin" | "compute" | "health" | "asset" {
  const u = new URL(request.url),
    local = env.ENVIRONMENT === "local" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (env.ENVIRONMENT === "local")
    assert(local, "FORBIDDEN", "Local authentication accepts loopback traffic only.", 403);
  const admin = local || u.origin === env.ADMIN_ORIGIN,
    broker = local || u.hostname === env.BROKER_HOSTNAME;
  if (u.pathname === "/healthz" && broker) return "health";
  if (u.pathname.startsWith("/api/")) {
    assert(broker, "FORBIDDEN", "Compute endpoints are available only on the broker origin.", 403);
    return "compute";
  }
  if (u.pathname.startsWith("/admin-api/")) {
    assert(
      admin,
      "FORBIDDEN",
      "Administration is available only on the configured admin origin.",
      403,
    );
    return "admin";
  }
  assert(
    admin && (u.pathname === "/" || u.pathname === "/admin" || u.pathname.startsWith("/admin/")),
    "FORBIDDEN",
    "Unknown host or route.",
    403,
  );
  return "asset";
}
export async function authenticateAdmin(request: Request, env: Env): Promise<Actor> {
  if (env.ENVIRONMENT === "local" && env.DEV_AUTH === "true")
    return {
      kind: "admin",
      id: request.headers.get("X-Local-Subject") ?? "local-owner",
      email: "local@example.test",
      owner: true,
    };
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  assert(token, "UNAUTHENTICATED", "Sign in through Cloudflare Access.", 401);
  try {
    const issuer = env.ACCESS_ISSUER!.replace(/\/$/, "");
    let keys = jwks.get(issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
        cacheMaxAge: 300000,
        cooldownDuration: 30000,
        timeoutDuration: 5000,
      });
      if (jwks.size >= 4) jwks.clear();
      jwks.set(issuer, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: env
        .ACCESS_AUDIENCE!.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      algorithms: ["RS256"],
      requiredClaims: ["sub", "email", "exp"],
    });
    assert(
      typeof payload.sub === "string" &&
        payload.sub.trim().length > 0 &&
        typeof payload.email === "string" &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email),
      "UNAUTHENTICATED",
      "Identity claims are incomplete.",
      401,
    );
    const email = payload.email.trim().toLowerCase(),
      owner = env.OWNER_EMAILS.split(",")
        .map((s) => s.trim().toLowerCase())
        .includes(email);
    if (!owner)
      assert(
        await one(
          env.DB,
          "SELECT subject FROM administrators WHERE subject=? AND active=1",
          payload.sub,
        ),
        "FORBIDDEN",
        "This identity is not an administrator.",
        403,
      );
    return { kind: "admin", id: payload.sub, email, owner };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      "UNAUTHENTICATED",
      "The Access identity could not be verified. Sign in again.",
      401,
    );
  }
}
export async function authenticateKey(request: Request, env: Env): Promise<Actor> {
  const auth = request.headers.get("Authorization") ?? "",
    match = /^Bearer tb_([0-9a-f-]{36})_([0-9a-f]{64})$/i.exec(auth);
  assert(match, "UNAUTHENTICATED", "A family API key is required.", 401);
  const key = await one(
    env.DB,
    "SELECT id,family_id,label,secret_digest,status FROM api_keys WHERE id=?",
    match[1],
  );
  const digest = await sha256(match[2]);
  let diff = 0;
  const expected = key?.secret_digest ?? "0".repeat(64);
  for (let i = 0; i < 64; i++) diff |= digest.charCodeAt(i) ^ expected.charCodeAt(i);
  assert(key && diff === 0, "UNAUTHENTICATED", "Invalid API key.", 401);
  assert(key.status !== "hard_revoked", "KEY_REVOKED", "This key has been hard-revoked.", 403);
  return {
    kind: "key",
    id: key.id,
    family_id: key.family_id,
    status: key.status,
    label: key.label,
  };
}
export function checkCSRF(request: Request, env: Env) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  const allowed =
    origin === env.ADMIN_ORIGIN ||
    (env.ENVIRONMENT === "local" && origin === "http://127.0.0.1:5173");
  assert(
    allowed && request.headers.get("X-Task-Broker") === "1",
    "FORBIDDEN",
    "Administration mutations require the application origin and request header.",
    403,
  );
}
