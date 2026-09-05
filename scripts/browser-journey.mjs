import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { origin, config } from "./verification-api.mjs";
import { accessToken } from "./access-session.mjs";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".cache/ms-playwright");
const { chromium } = await import("@playwright/test");
const token = await accessToken(config.vars.ACCESS_AUDIENCE);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies([
  { name: "CF_Authorization", value: token, url: origin, secure: true, httpOnly: true },
]);
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(origin + "/admin/start/");
  await page.getByRole("button", { name: "Create disposable demo", exact: true }).click();
  await page
    .getByText("Temporary family key (shown once)", { exact: false })
    .waitFor({ timeout: 30000 });
  const key = await page.getByLabel("Temporary family key (shown once)").inputValue();
  const code = await page.locator("dialog pre").allTextContents();
  const slug = /from_env\('(demo-[a-f0-9]+)'\)/.exec(code.join("\n"))?.[1];
  assert(slug);
  const downloadWait = page.waitForEvent("download");
  await page.locator("dialog").getByRole("link", { name: "Download the Python client" }).click();
  const download = await downloadWait;
  await mkdir("artifacts/private/journey", { recursive: true });
  await download.saveAs("artifacts/private/journey/task_pool.py");
  const python = `from task_pool import TaskClient; c=TaskClient.from_env('${slug}'); tasks=c.claim(1); assert len(tasks)==1; t=tasks[0]; assert t.data['n']==7; t.complete({'diameter': int(t.data['n'])**2}); print('Python claimed and reported 49')`;
  await new Promise((yes, no) => {
    const p = spawn("python", ["-c", python], {
      cwd: resolve("artifacts/private/journey"),
      env: { ...process.env, TASK_MANAGER_URL: origin, TASK_MANAGER_KEY: key },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error = "";
    p.stderr.on("data", (b) => (error += b));
    p.on("error", no);
    p.on("exit", (n) => (n ? no(new Error(`Python journey failed: ${error}`)) : yes()));
  });
  await page.getByRole("button", { name: "Verify Python result", exact: true }).click();
  await page.getByText("Verified: Python claimed the task", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Open demo results", exact: true }).click();
  // Redact the one-time credential before collecting browser evidence.
  await page.getByRole("button", { name: "Revoke key and archive demo", exact: true }).click();
  await page.getByText("Demo archived; temporary credentials revoked.", { exact: false }).waitFor();
  await page.locator("dialog").evaluate((d) => d.close());
  await page.getByRole("button", { name: "Refresh / resume", exact: true }).click();
  await page.locator(".tabulator-row").filter({ hasText: "demo-square" }).waitFor();
  await mkdir("artifacts/private/verification", { recursive: true });
  await page.screenshot({
    path: "artifacts/private/verification/staging-browser-result.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const csvWait = page.waitForEvent("download", {
    predicate: (d) => d.suggestedFilename().endsWith(".csv"),
  });
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const csv = await csvWait;
  await csv.saveAs("artifacts/private/verification/staging-journey.csv");
  const contents = await readFile("artifacts/private/verification/staging-journey.csv", "utf8");
  assert(contents.includes("diameter"));
  assert(contents.includes("completed"));
  assert(contents.includes("49"));
  assert.deepEqual(errors, []);
  await writeFile(
    "artifacts/private/verification/staging-journey.json",
    JSON.stringify(
      {
        completed: true,
        recorded_at: new Date().toISOString(),
        origin,
        checks: [
          "Access-protected browser-created demo",
          "browser-downloaded dependency-free Python client",
          "Python claim and report through public compute path",
          "browser visible result 49",
          "real CSV content",
          "temporary key hard-revoked and demo archived",
        ],
        page_errors: errors,
      },
      null,
      2,
    ),
  );
  console.log("PASS browser -> downloaded Python -> public claim/report -> browser result -> CSV");
} finally {
  await browser.close();
}
