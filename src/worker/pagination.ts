import { AppError, assert, canonical, sha256 } from "../shared/core";
import type { Env } from "./types";
const b64 = (a: Uint8Array) =>
  btoa(String.fromCharCode(...a))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const unb64 = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
async function key(env: Env) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.APP_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function encodeCursor(env: Env, scope: unknown, data: unknown) {
  const body = b64(
    new TextEncoder().encode(
      canonical({
        scope: await sha256(canonical(scope)),
        epoch: env.INSTANCE_EPOCH,
        data,
        expires: Date.now() + 86400000,
      }),
    ),
  );
  return `${body}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), new TextEncoder().encode(body))))}`;
}
export async function decodeCursor(env: Env, cursor: string, scope: unknown): Promise<any> {
  try {
    const [body, signature, ...extra] = cursor.split(".");
    assert(!extra.length && body && signature, "INVALID_VALUE", "Invalid cursor.");
    assert(
      await crypto.subtle.verify(
        "HMAC",
        await key(env),
        unb64(signature),
        new TextEncoder().encode(body),
      ),
      "INVALID_VALUE",
      "Invalid cursor signature.",
    );
    const parsed = JSON.parse(new TextDecoder().decode(unb64(body)));
    assert(
      parsed.expires > Date.now() &&
        parsed.epoch === env.INSTANCE_EPOCH &&
        parsed.scope === (await sha256(canonical(scope))),
      "INVALID_VALUE",
      "Cursor expired or does not match this view.",
    );
    return parsed.data;
  } catch {
    throw new AppError("INVALID_VALUE", "Invalid or expired pagination cursor.");
  }
}
