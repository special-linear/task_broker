import { spawn } from "node:child_process";
import { wranglerConfigPath } from "./wrangler-config.ts";

const args = process.argv.slice(2);
const explicit = args.some(
  (arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config="),
);
const child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    ...args,
    ...(explicit ? [] : ["--config", wranglerConfigPath()]),
  ],
  { stdio: "inherit", env: process.env },
);
child.on("error", () => {
  console.error("Unable to start local Wrangler.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
