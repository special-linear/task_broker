import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const meta = () => ({
  request_id: crypto.randomUUID(),
  request_created_at: new Date().toISOString(),
});
async function admin(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/admin-api/v1${path}`, {
    headers: { Origin: "http://127.0.0.1:8787", "X-Task-Broker": "1" },
    data,
  });
  const body = await response.json();
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return body.data;
}

let poolId: string;
let poolName: string;
test.beforeAll(async ({ request }) => {
  await admin(request, "/bootstrap", meta());
  poolName = `interface-${crypto.randomUUID().slice(0, 8)}`;
  const family = await admin(request, "/families", { ...meta(), slug: poolName, name: poolName });
  const pool = await admin(request, "/pools", {
    ...meta(),
    family_id: family.id,
    name: poolName,
    fields: [{ key: "n", label: "Number", type: "integer" }],
  });
  poolId = pool.id;
  const op = await admin(request, "/imports/preview", {
    ...meta(),
    pool_id: poolId,
    mode: "add",
    total: 600,
  });
  for (let start = 0; start < 600; start += 50)
    await admin(request, `/imports/${op.operation_id}/preview-chunks`, {
      ...meta(),
      start,
      rows: Array.from({ length: 50 }, (_, i) => ({
        task_id: `row-${String(start + i).padStart(3, "0")}`,
        data: { n: start + i },
      })),
    });
  for (let start = 0; start < 600; start += 50)
    await admin(request, `/imports/${op.operation_id}/chunks`, { ...meta(), limit: 50 });
});
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.addInitScript((id) => localStorage.setItem("task-broker:last-pool", id), poolId);
  await page.goto("/admin/tasks");
  await expect(page.locator(".tabulator-row").first()).toBeVisible();
});

const task = (page: Page, id: string) =>
  page.locator(".tabulator-row").filter({
    has: page.locator('[tabulator-field="task_id"]', { hasText: new RegExp(`^${id}$`) }),
  });
const holder = (page: Page) => page.locator("#task-grid .tabulator-tableholder");
const viewport = (page: Page) =>
  holder(page).evaluate((node) => ({
    top: node.scrollTop,
    left: node.scrollLeft,
  }));
async function expectInlineCheckbox(input: Locator) {
  const layout = await input.evaluate((node) => {
    const control = node.getBoundingClientRect();
    const text = node.parentElement!.querySelector("span")!.getBoundingClientRect();
    return {
      left: control.right <= text.left,
      aligned: Math.abs(control.y + control.height / 2 - text.y - text.height / 2) < 2,
    };
  });
  expect(layout).toEqual({ left: true, aligned: true });
}

test("Shift-click extends checkbox and row selections in the displayed order", async ({ page }) => {
  await task(page, "row-001").getByRole("checkbox").check();
  await task(page, "row-005")
    .getByRole("checkbox")
    .click({ modifiers: ["Shift"] });
  await expect(page.getByText("5 selected (loaded rows)", { exact: true })).toBeVisible();
  for (let i = 1; i <= 5; i++)
    await expect(task(page, `row-00${i}`).getByRole("checkbox")).toBeChecked();
  await task(page, "row-005")
    .getByRole("checkbox")
    .click({ modifiers: ["Shift"] });
  await expect(task(page, "row-005").getByRole("checkbox")).toBeChecked();
  await task(page, "row-007").locator('[tabulator-field="task_id"]').click();
  await task(page, "row-009")
    .locator('[tabulator-field="task_id"]')
    .click({ modifiers: ["Shift"] });
  await expect(page.getByText("8 selected (loaded rows)", { exact: true })).toBeVisible();
  await task(page, "row-008").getByRole("checkbox").press("Space");
  await expect(task(page, "row-008").getByRole("checkbox")).not.toBeChecked();
  await page.locator(".tabulator-header input[type=checkbox]").click();
  await expect(page.getByText("0 selected (loaded rows)", { exact: true })).toBeVisible();
  await page.locator('.tabulator-col[tabulator-field="task_id"]').click();
  await expect(task(page, "row-599")).toBeVisible();
  await task(page, "row-595").getByRole("checkbox").check();
  await task(page, "row-599")
    .getByRole("checkbox")
    .click({ modifiers: ["Shift"] });
  await expect(page.getByText("5 selected (loaded rows)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh / resume" }).click();
  await task(page, "row-597")
    .getByRole("checkbox")
    .click({ modifiers: ["Shift"] });
  await expect(page.getByText("5 selected (loaded rows)", { exact: true })).toBeVisible();
});

test("refresh and bulk updates preserve the viewport and existing row elements", async ({
  page,
}) => {
  await holder(page).evaluate((node) => {
    node.scrollTop = 1800;
  });
  const row = task(page, "row-052");
  await row.getByRole("checkbox").check();
  await holder(page).evaluate((node) => {
    node.scrollLeft = 200;
  });
  const before = await viewport(page);
  expect(before.top).toBeGreaterThan(1000);
  expect(before.left).toBeGreaterThan(0);
  const original = await row.elementHandle();
  await page.getByRole("button", { name: "Refresh / resume" }).click();
  await expect(page.getByRole("button", { name: "Refresh / resume" })).toBeEnabled();
  expect(await viewport(page)).toEqual(before);
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await page.getByRole("button", { name: "Bulk actions", exact: true }).click();
  await page.getByRole("combobox", { name: "Action", exact: true }).selectOption("disable");
  await page.getByRole("button", { name: "Preview operation", exact: true }).click();
  await page.getByRole("button", { name: "Apply reviewed action", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("1 applied, 0 conflicting or rejected");
  await expect(
    page.getByRole("button", { name: "Apply reviewed action", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  expect(await viewport(page)).toEqual(before);
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.getByText("1 selected (loaded rows)", { exact: true })).toBeVisible();
});

test("All refresh keeps distant rows visible through cancellation and retry", async ({ page }) => {
  await page.getByLabel("Page size").selectOption("all");
  await expect(page.locator("#all-load-progress")).toContainText("All 600 rows loaded");
  await task(page, "row-001").getByRole("checkbox").check();
  await holder(page).evaluate((node) => {
    node.scrollTop = 500 * node.querySelector(".tabulator-row")!.getBoundingClientRect().height;
  });
  await task(page, "row-502")
    .getByRole("checkbox")
    .click({ modifiers: ["Shift"] });
  await expect(page.getByText("502 selected (loaded rows)", { exact: true })).toBeVisible();
  const before = await viewport(page);
  const original = await task(page, "row-502").elementHandle();
  let held = false;
  let release: (() => void) | undefined;
  await page.route(`**/pools/${poolId}/tasks?**`, async (route) => {
    if (!held && new URL(route.request().url()).searchParams.has("cursor")) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await route.continue().catch(() => {});
  });
  try {
    await page.getByRole("button", { name: "Refresh / resume" }).click();
    await expect.poll(() => held).toBe(true);
    expect(await viewport(page)).toEqual(before);
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
    // A new deselection during the pending request must survive the refresh.
    await task(page, "row-502").getByRole("checkbox").uncheck();
    await page.getByRole("button", { name: "Cancel loading", exact: true }).click();
    await expect(page.locator("#all-load-progress")).toContainText("250 of 600 loaded");
    expect(await viewport(page)).toEqual(before);
    release!();
    await page.getByRole("button", { name: "Retry loading", exact: true }).click();
    await expect(page.locator("#all-load-progress")).toContainText("All 600 rows loaded");
    expect(await viewport(page)).toEqual(before);
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(task(page, "row-502").getByRole("checkbox")).not.toBeChecked();
    await expect(page.getByText("501 selected (loaded rows)", { exact: true })).toBeVisible();
  } finally {
    release?.();
    await page.unroute(`**/pools/${poolId}/tasks?**`);
  }
});

test("checkboxes align with labels and immediate settings close without a discard prompt", async ({
  page,
}) => {
  const prompts: string[] = [];
  page.on("dialog", async (d) => {
    prompts.push(d.message());
    await d.dismiss();
  });
  await expectInlineCheckbox(page.getByLabel("Live refresh", { exact: true }));
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await expectInlineCheckbox(page.getByRole("dialog").getByLabel("Admin note", { exact: true }));
  await page.getByRole("dialog").getByLabel("Admin note", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("combobox", { name: "Format", exact: true }).selectOption("json");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await download;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Pools & profiles", exact: true }).click();
  await expectInlineCheckbox(page.getByLabel("Show archived", { exact: true }));
  expect(prompts).toEqual([]);
});

test("completed imports and index definitions close cleanly; unsaved edits still prompt", async ({
  page,
}) => {
  const prompts: string[] = [];
  page.on("dialog", async (d) => {
    prompts.push(d.message());
    await d.dismiss();
  });
  await page.getByRole("button", { name: "Import / paste", exact: true }).click();
  await page
    .getByRole("dialog")
    .locator("textarea")
    .fill(`task_id,n\nimport-${crypto.randomUUID()},42`);
  await page.getByRole("button", { name: "Parse and preview", exact: true }).click();
  await page.getByRole("button", { name: "Validate complete import", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("1 ready, 0 rejected");
  await page.getByRole("button", { name: "Save reviewed import", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save reviewed import", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Pools & profiles", exact: true }).click();
  const pool = page
    .locator("tr")
    .filter({ has: page.getByLabel(`${poolName} name`, { exact: true }) });
  await pool.getByRole("button", { name: "Claim sort indexes", exact: true }).click();
  await page.getByLabel("Index name", { exact: true }).fill("Saved order");
  await page.getByRole("button", { name: "Save index definition", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Saved order");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(prompts).toEqual([]);
  await pool.getByRole("button", { name: "Claim sort indexes", exact: true }).click();
  await page.getByLabel("Index name", { exact: true }).fill("Unsaved order");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(prompts).toEqual(["Discard the unsaved changes in this form?"]);
});

test("failed saves and edits made while saving still prompt before closing", async ({ page }) => {
  const prompts: string[] = [];
  page.on("dialog", async (d) => {
    prompts.push(d.message());
    await d.dismiss();
  });
  await page.getByRole("button", { name: "Pools & profiles", exact: true }).click();
  const pool = page
    .locator("tr")
    .filter({ has: page.getByLabel(`${poolName} name`, { exact: true }) });
  await pool.getByRole("button", { name: "Claim sort indexes", exact: true }).click();
  const name = page.getByLabel("Index name", { exact: true });
  const save = page.getByRole("button", { name: "Save index definition", exact: true });
  const close = page.getByRole("button", { name: "Close dialog", exact: true });
  await name.fill("Failed order");
  await page.route(`**/pools/${poolId}/claim-sort-indexes`, (route) => route.abort(), { times: 1 });
  await save.click();
  await expect(
    page.getByText("Connection lost. Your changes are still unsaved.", { exact: true }),
  ).toBeVisible();
  await close.click();
  await expect(name).toHaveValue("Failed order");
  expect(prompts).toHaveLength(1);
  let release: (() => void) | undefined;
  await page.route(`**/pools/${poolId}/claim-sort-indexes`, async (route) => {
    if (route.request().method() === "POST") {
      const response = await route.fetch();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await save.click();
    await expect.poll(() => !!release).toBe(true);
    await name.fill("New draft during save");
    release!();
    await expect(save).toBeEnabled();
    await expect(page.getByRole("dialog")).toContainText("Failed order");
    await close.click();
    await expect(name).toHaveValue("New draft during save");
    expect(prompts).toHaveLength(2);
  } finally {
    release?.();
    await page.unroute(`**/pools/${poolId}/claim-sort-indexes`);
  }
});

test("long dialogs keep Close visible while their content scrolls, including small screens", async ({
  page,
}) => {
  for (const size of [
    { width: 1280, height: 720 },
    { width: 390, height: 600 },
  ]) {
    await page.setViewportSize(size);
    await page.getByRole("button", { name: "Draft rows", exact: true }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Blank rows", { exact: true }).fill("30");
    await d.getByLabel("Blank rows", { exact: true }).press("Tab");
    const close = d.getByRole("button", { name: "Close dialog", exact: true });
    const before = await close.boundingBox();
    await d.locator(".dialog-content").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    expect(await d.locator(".dialog-content").evaluate((node) => node.scrollTop)).toBeGreaterThan(
      0,
    );
    expect(await close.boundingBox()).toEqual(before);
    await expect(close).toBeInViewport();
    page.once("dialog", (prompt) => prompt.accept());
    await close.click();
    await expect(d).toHaveCount(0);
  }
});
