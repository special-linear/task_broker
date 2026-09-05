import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import Papa from "papaparse";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".cache/ms-playwright");
const { chromium } = await import("@playwright/test"),
  origin = "http://127.0.0.1:8787";
const meta = () => ({ request_id: randomUUID(), request_created_at: new Date().toISOString() });
async function admin(path, body) {
  const r = await fetch(origin + "/admin-api/v1" + path, {
    method: body ? "POST" : "GET",
    headers: { Origin: origin, "X-Task-Broker": "1", "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  assert(j.ok, JSON.stringify(j.error));
  return j.data;
}
await admin("/bootstrap", meta());
const slug = "browser-scale-" + randomUUID().slice(0, 8),
  family = await admin("/families", { ...meta(), slug, name: slug }),
  pool = await admin("/pools", {
    ...meta(),
    family_id: family.id,
    name: slug,
    fields: [
      { key: "n", label: "n", type: "integer", required: true },
      { key: "text", label: "Text", type: "string", required: true },
      { key: "seed", label: "Seed", type: "integer", required: true },
    ],
  });
const data = Array.from({ length: 10000 }, (_, i) => ({
    task_id: `row-${String(i).padStart(5, "0")}`,
    n: String(i),
    text: i === 0 ? "=SUM(1,2)" : 'Unicode λ, quoted "text"\nsecond line',
    seed: String(9007199254740993n + BigInt(i)),
  })),
  csv = Papa.unparse(data);
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext(),
  page = await context.newPage();
page.setDefaultTimeout(30000);
const start = Date.now();
try {
  await page.addInitScript((id) => localStorage.setItem("task-broker:last-pool", id), pool.id);
  await page.goto(origin + "/admin/tasks");
  await page.getByRole("button", { name: "Import / paste", exact: true }).click();
  await page.locator("dialog input[type=file]").setInputFiles({
    name: "representative-10000.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.waitForFunction(
    () => document.querySelector("dialog textarea")?.value.length > 100000,
  );
  await page.getByRole("button", { name: "Parse and preview" }).click();
  await page.getByRole("heading", { name: /10.000 rows detected/ }).waitFor();
  await page.getByRole("button", { name: "Validate complete import" }).click();
  await page.getByText("10000 ready, 0 rejected.", { exact: false }).waitFor({ timeout: 300000 });
  let lost = false;
  const sent = [];
  await page.route("**/admin-api/v1/imports/*/chunks", async (route) => {
    sent.push(route.request().postData());
    if (!lost) {
      lost = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Save reviewed import" }).click();
  await page.getByText("Connection lost.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Save reviewed import" }).click();
  await page.getByText("Import finished.", { exact: false }).waitFor({ timeout: 300000 });
  assert.equal(sent[0], sent[1]);
  await page.locator("dialog").evaluate((d) => d.close());
  const count = await admin(`/pools/${pool.id}/tasks?limit=1`);
  assert.equal(count.total, 10000);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const downloadWait = page.waitForEvent("download", {
    predicate: (d) => d.suggestedFilename().endsWith(".csv"),
    timeout: 300000,
  });
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const file = await downloadWait,
    stream = await file.createReadStream();
  let exported = "";
  for await (const b of stream) exported += b;
  const rows = Papa.parse(exported, { header: true, skipEmptyLines: true }).data;
  assert.equal(rows.length, 10000);
  assert.equal(rows[0].seed, "9007199254740993");
  assert.equal(rows[9999].seed, "9007199254750992");
  assert.equal(rows[0].text, "'=SUM(1,2)");
  assert.equal(rows[1].text, data[1].text);
  await mkdir("artifacts/private/verification", { recursive: true });
  await writeFile(
    "artifacts/private/verification/browser-scale.json",
    JSON.stringify(
      {
        completed: true,
        recorded_at: new Date().toISOString(),
        environment: "local workerd/D1, Chromium",
        task_count: 10000,
        elapsed_ms: Date.now() - start,
        checks: [
          "CSV parsed in browser worker",
          "quoted multiline Unicode and exact large integers",
          "complete server preview",
          "lost committed chunk replayed with exact request bytes",
          "10000 tasks without duplicates",
          "complete browser CSV download",
          "formula prefix and text fidelity",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS browser 10,000-row import with lost response and complete safe CSV export.");
} catch (error) {
  await mkdir("artifacts/private", { recursive: true });
  await writeFile(
    "artifacts/private/browser-scale-failure.txt",
    await page.locator("body").innerText(),
  );
  throw error;
} finally {
  await browser.close();
}
