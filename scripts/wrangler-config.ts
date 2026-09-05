import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";

export function wranglerConfigPath(explicit?: string): string {
  return (
    explicit ??
    process.env.WRANGLER_CONFIG ??
    (existsSync("wrangler.staging.local.jsonc") ? "wrangler.staging.local.jsonc" : "wrangler.jsonc")
  );
}

export async function loadWranglerConfig(explicit?: string) {
  return parse(await readFile(wranglerConfigPath(explicit), "utf8"));
}
