import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// Read a session established by the official cloudflared login flow. Never log it.
export async function accessToken(audience = process.env.ACCESS_AUDIENCE) {
  if (process.env.CF_ACCESS_TOKEN) return process.env.CF_ACCESS_TOKEN;
  if (process.env.CF_ACCESS_TOKEN_FILE)
    return (await readFile(process.env.CF_ACCESS_TOKEN_FILE, "utf8")).trim();
  const directory = join(homedir(), ".cloudflared");
  for (const file of await readdir(directory).catch(() => [])) {
    if (!file.endsWith(".token") && !file.endsWith("-token")) continue;
    const value = (await readFile(join(directory, file), "utf8")).trim();
    try {
      const claims = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString());
      if (
        claims.exp * 1000 > Date.now() &&
        (!audience || audience.split(",").some((a) => claims.aud.includes(a.trim())))
      )
        return value;
    } catch {
      /* Unrelated local certificate or expired session. */
    }
  }
  throw new Error("No current Access session. Run cloudflared access login --quiet <admin URL>.");
}
if (process.argv.includes("--save-test-session")) {
  const { loadWranglerConfig } = await import("./wrangler-config.ts");
  const staging = (await loadWranglerConfig()).env.staging;
  const token = await accessToken(staging.vars.ACCESS_AUDIENCE);
  await mkdir("artifacts/private", { recursive: true });
  await writeFile("artifacts/private/access.token", token, { mode: 0o600 });
  const response = await fetch(staging.vars.ADMIN_ORIGIN + "/admin-api/v1/me", {
    headers: { Cookie: `CF_Authorization=${token}` },
    redirect: "manual",
  });
  console.log(
    JSON.stringify({
      status: response.status,
      identity: response.status === 200 ? await response.json() : null,
    }),
  );
}
