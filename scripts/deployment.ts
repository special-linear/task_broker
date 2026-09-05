import { access } from "node:fs/promises";
import { loadWranglerConfig } from "./wrangler-config.ts";
const args = process.argv.slice(2),
  environment = args.includes("--env") ? args[args.indexOf("--env") + 1] : "production";
const config = await loadWranglerConfig(
    args.includes("--config") ? args[args.indexOf("--config") + 1] : undefined,
  ),
  chosen = environment === "production" ? config : config.env?.[environment];
if (!chosen) throw new Error(`Unknown deployment environment: ${environment}`);
const failures: string[] = [];
const require = (condition: unknown, message: string) => {
  if (!condition) failures.push(message);
};
const vars = chosen.vars;
require(vars?.ENVIRONMENT === environment, "ENVIRONMENT must match the selected environment.");
require(config.compatibility_date ===
  "2026-08-22", "Compatibility date must match the tested release.");
require(config.assets?.run_worker_first === true, "Worker-first authentication is mandatory.");
require(chosen.preview_urls !== true, "Deployment preview URLs must be disabled.");
if (environment === "production") {
  require(chosen.workers_dev === false, "Production workers.dev must be disabled.");
  require(new URL(vars.ADMIN_ORIGIN).hostname !==
    vars.BROKER_HOSTNAME, "Production requires separate administration and compute hosts.");
}
if (environment !== "local") {
  require(!vars.DEV_AUTH, "DEV_AUTH cannot appear in deployed configuration.");
  for (const field of [
    "ADMIN_ORIGIN",
    "BROKER_HOSTNAME",
    "ACCESS_ISSUER",
    "ACCESS_AUDIENCE",
    "OWNER_EMAILS",
  ])
    require(vars[field] &&
      !/REPLACE|YOUR-|example\.(com|test)/i.test(
        vars[field],
      ), `${field} needs a deployment-specific value.`);
  require(chosen.d1_databases?.some(
    (b: any) => b.binding === "DB" && /^[a-f0-9-]{36}$/.test(b.database_id),
  ), "DB must reference a provisioned D1 database.");
  require(chosen.ratelimits?.some(
    (b: any) => b.name === "ABUSE_LIMITER",
  ), "Configure Cloudflare abuse throttling.");
}
await access("dist/web/index.html").catch(() =>
  failures.push("Build browser assets before deployment."),
);
if (failures.length) throw new Error(failures.join("\n"));
console.log(
  `Validated ${environment}: host routing, Access configuration, D1 binding, assets and preview restrictions.`,
);
console.log(
  "Runtime additionally verifies INSTANCE_EPOCH and APP_SIGNING_SECRET. Ordinary deployments preserve both.",
);
