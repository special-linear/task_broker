import { admin, meta, origin } from "./verification-api.mjs";
import { wranglerConfigPath } from "./wrangler-config.ts";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
await mkdir("artifacts/private", { recursive: true });
const before = await admin("/diagnostics");
await admin("/maintenance", {
  ...meta(),
  maintenance: true,
  reason: "Consistent staging backup and isolated restore verification",
});
let completed = false;
try {
  const filename = resolve("artifacts/private/staging-consistent.sql");
  await new Promise((yes, no) => {
    const child = spawn(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "d1",
        "export",
        "DB",
        "--remote",
        "--env",
        "staging",
        "--config",
        wranglerConfigPath(),
        "--output",
        filename,
      ],
      {
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: resolve("artifacts/private/backup-wrangler.log"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", no);
    child.on("exit", async (n) => {
      await writeFile("artifacts/private/backup-cli.log", output, { mode: 0o600 });
      n ? no(new Error(`Native backup failed (${n}); inspect the private CLI log.`)) : yes();
    });
  });
  const bytes = await readFile(filename);
  const evidence = {
    origin,
    recorded_at: new Date().toISOString(),
    consistent: true,
    maintenance: true,
    sql_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    before,
  };
  await writeFile(
    "artifacts/private/verification/consistent-backup.json",
    JSON.stringify(evidence, null, 2),
  );
  completed = true;
} finally {
  if (!before.maintenance)
    await admin("/maintenance", {
      ...meta(),
      maintenance: false,
      reason: "Consistent staging export finished; source data unchanged",
    });
}
console.log(JSON.stringify({ backup_completed: completed, source_reopened: !before.maintenance }));
