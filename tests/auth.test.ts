import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, afterAll, test, expect, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { authenticateAdmin, routeKind } from "../src/worker/auth";
import type { Env } from "../src/worker/types";
import handler from "../src/worker/index";
const issuer = "https://auth.example.test",
  audience = "test-application";
let key: CryptoKey;
const deployed = {
  ...env,
  ENVIRONMENT: "staging",
  DEV_AUTH: undefined,
  ADMIN_ORIGIN: "https://admin.example.test",
  BROKER_HOSTNAME: "broker.example.test",
  ACCESS_ISSUER: issuer,
  ACCESS_AUDIENCE: audience,
  OWNER_EMAILS: "owner@example.test",
} as Env;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const pair = await generateKeyPair("RS256", { extractable: true });
  key = pair.privateKey;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(issuer + "/cdn-cgi/access/certs");
    return Response.json({
      keys: [
        { ...(await exportJWK(pair.publicKey)), kid: "verification", alg: "RS256", use: "sig" },
      ],
    });
  });
});
afterAll(() => vi.unstubAllGlobals());
async function signed(
  options: { aud?: string; iss?: string; exp?: number; email?: string; sub?: string } = {},
) {
  return new SignJWT({ email: options.email ?? "owner@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "verification" })
    .setSubject(options.sub ?? "verified-owner")
    .setIssuer(options.iss ?? issuer)
    .setAudience(options.aud ?? audience)
    .setExpirationTime(options.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(key);
}
const request = (token?: string) =>
  new Request("https://admin.example.test/admin-api/v1/me", {
    headers: token
      ? { "Cf-Access-Jwt-Assertion": token }
      : { "Cf-Access-Authenticated-User-Email": "owner@example.test" },
  });
test("AUTH-01: deployed JWT validation verifies signature, audience, issuer, expiry and identity", async () => {
  expect((await authenticateAdmin(request(await signed()), deployed)).kind).toBe("admin");
  for (const token of [
    undefined,
    "forged",
    await signed({ aud: "other" }),
    await signed({ iss: "https://other.example" }),
    await signed({ exp: 1 }),
    await signed({ sub: "" }),
    await signed({ email: "invalid" }),
  ])
    await expect(authenticateAdmin(request(token), deployed)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  await expect(
    authenticateAdmin(request(await signed({ email: "stranger@example.test" })), deployed),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
test("AUTH-02: alternate host and broker-host admin paths cannot become assets", () => {
  for (const url of [
    "https://broker.example.test/admin/",
    "https://broker.example.test/admin-api/v1/me",
    "https://preview.workers.dev/admin/",
    "https://admin.example.test/assets/app.js",
  ])
    expect(() => routeKind(new Request(url), deployed)).toThrow();
  expect(routeKind(new Request("https://broker.example.test/api/v1/claim"), deployed)).toBe(
    "compute",
  );
});

test("PERF-02: provider quota errors on reads become explicit non-retryable errors", async () => {
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return () => {
          throw new Error(
            "D1_ERROR: Your account has exceeded D1's free tier daily row read limit.",
          );
        };
      return Reflect.get(target, property);
    },
  });
  const response = await handler.fetch(new Request("http://127.0.0.1:8787/admin-api/v1/me"), {
    ...env,
    DB: db,
  });
  expect(response.status).toBe(503);
  expect((await response.json<any>()).error).toMatchObject({
    code: "QUOTA_EXCEEDED",
    retryable: false,
  });
  expect(response.headers.has("Retry-After")).toBe(false);
});
