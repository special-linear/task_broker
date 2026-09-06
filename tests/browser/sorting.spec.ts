import { test, expect, type APIRequestContext } from "@playwright/test";
const meta = () => ({
  request_id: crypto.randomUUID(),
  request_created_at: new Date().toISOString(),
});

test("legacy saved-view labels normalize before local sorting and header promotion", async ({
  page,
  request,
}) => {
  await admin(request, "/bootstrap", meta());
  const slug = "legacy-sort-" + crypto.randomUUID().slice(0, 8);
  const family = await admin(request, "/families", { ...meta(), slug, name: slug });
  const pool = await admin(request, "/pools", {
    ...meta(),
    family_id: family.id,
    name: slug,
    fields: [{ key: "n", label: "Size", type: "integer" }],
  });
  for (const [i, n] of [3, 1, 2].entries())
    await admin(request, `/pools/${pool.id}/tasks`, {
      ...meta(),
      task_id: "row-" + i,
      data: { n },
    });
  const view = await admin(request, "/views", {
    ...meta(),
    pool_id: pool.id,
    name: "Legacy label",
    presentation: { sorts: [{ field: "n", direction: "desc" }], page_size: "all" },
  });
  // Simulate an existing pre-migration presentation, which is still readable.
  await page.route("**/admin-api/v1/views*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const row of body.data.rows ?? [])
      if (row.id === view.id)
        row.presentation = {
          filter: "",
          sort: "SIZE",
          direction: "desc",
          page_size: "all",
          columns: [],
        };
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript((id) => localStorage.setItem("task-broker:last-pool", id), pool.id);
  await page.goto("/admin/tasks");
  await page.getByRole("button", { name: "Saved views", exact: true }).click();
  await page.getByRole("button", { name: "Legacy label", exact: true }).click();
  const header = page.locator('.tabulator-col[tabulator-field="input:n"]');
  await expect(header).toContainText("↓ 1");
  await expect(page.locator("#all-load-progress")).toContainText("All 3 rows loaded");
  let reads = 0;
  page.on("request", (r) => {
    if (r.url().includes(`/pools/${pool.id}/tasks?`)) reads++;
  });
  await header.click();
  await expect(header).toContainText("↑ 1");
  await expect(
    page.locator('.tabulator-row .tabulator-cell[tabulator-field="input:n"]').first(),
  ).toHaveText("1");
  expect(reads).toBe(0);
});
async function admin(request: APIRequestContext, path: string, data?: unknown) {
  const response = await request.fetch(`/admin-api/v1${path}`, {
    method: data ? "POST" : "GET",
    headers: { Origin: "http://127.0.0.1:8787", "X-Task-Broker": "1" },
    ...(data ? { data } : {}),
  });
  const body = await response.json();
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return body.data;
}

test("10,000 rows: stable header history, local All sorting, cancellation, retry and stale responses", async ({
  page,
  request,
}) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(10000);
  await admin(request, "/bootstrap", meta());
  const slug = "sort-browser-" + crypto.randomUUID().slice(0, 8);
  const family = await admin(request, "/families", { ...meta(), slug, name: slug });
  const pool = await admin(request, "/pools", {
    ...meta(),
    family_id: family.id,
    name: slug,
    fields: [
      { key: "a", label: "A", type: "integer" },
      { key: "b", label: "B", type: "integer" },
    ],
  });
  const rows = Array.from({ length: 10000 }, (_, i) => ({
    task_id: `row-${String(i).padStart(5, "0")}`,
    data: { a: i % 5, b: (10000 - i) % 101 },
  }));
  const op = await admin(request, "/imports/preview", {
    ...meta(),
    pool_id: pool.id,
    mode: "add",
    total: rows.length,
  });
  for (let start = 0; start < rows.length; start += 50)
    await admin(request, `/imports/${op.operation_id}/preview-chunks`, {
      ...meta(),
      start,
      rows: rows.slice(start, start + 50),
    });
  while (
    (await admin(request, `/imports/${op.operation_id}/chunks`, { ...meta(), limit: 50 })).items
      .length
  ) {
    /* reviewed import */
  }
  await page.addInitScript((id) => localStorage.setItem("task-broker:last-pool", id), pool.id);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let reads = 0;
  page.on("request", (r) => {
    if (r.url().includes(`/pools/${pool.id}/tasks?`)) reads++;
  });
  await page.goto("/admin/tasks");
  const a = page.locator('.tabulator-col[tabulator-field="input:a"]'),
    b = page.locator('.tabulator-col[tabulator-field="input:b"]');
  await expect(a).toBeVisible();
  await b.click();
  await expect(b).toContainText("↑ 1");
  await a.click();
  await expect(a).toContainText("↑ 1");
  await expect(b).toContainText("↑ 2");
  await page.getByLabel("Page size").selectOption("all");
  await expect(page.locator("#all-load-progress")).toContainText("All 10,000 rows loaded", {
    timeout: 60000,
  });
  await expect(page.getByLabel("Live refresh")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next →" })).toBeHidden();
  expect(await page.locator(".tabulator-row").count()).toBeLessThan(200);
  await page.locator('.tabulator-row input[type="checkbox"]').first().check();
  const loadedReads = reads;
  await a.click();
  await expect(a).toContainText("↓ 1");
  expect(reads).toBe(loadedReads);
  await expect(page.getByText("1 selected (loaded rows)", { exact: true })).toBeVisible();
  const expected = [...rows].sort(
    (x, y) => y.data.a - x.data.a || x.data.b - y.data.b || x.task_id.localeCompare(y.task_id),
  );
  await expect(
    page.locator('.tabulator-row .tabulator-cell[tabulator-field="task_id"]').first(),
  ).toHaveText(expected[0].task_id);
  // Export uses the same complete sort, including rows outside the virtual viewport.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  let csv = "";
  for await (const chunk of (await (await download).createReadStream())!) csv += chunk.toString();
  expect(
    csv
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(",")[0]),
  ).toEqual(expected.map((r) => r.task_id));
  await page.getByRole("button", { name: "Close dialog" }).click();
  // Hold the second page, cancel, then resume from the last committed page.
  let release: (() => void) | undefined;
  let held = false;
  await page.route(`**/pools/${pool.id}/tasks?**`, async (route) => {
    if (!held && new URL(route.request().url()).searchParams.has("cursor")) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await route.continue().catch(() => {});
  });
  await page.getByRole("button", { name: "Refresh / resume" }).click();
  await expect.poll(() => held).toBe(true);
  await page.getByRole("button", { name: "Cancel loading", exact: true }).click();
  await expect(page.locator("#all-load-progress")).toContainText(
    "250 of 10,000 loaded · incomplete",
  );
  release!();
  await page.getByRole("button", { name: "Retry loading", exact: true }).click();
  await expect(page.locator("#all-load-progress")).toContainText("All 10,000 rows loaded", {
    timeout: 60000,
  });
  await page.unroute(`**/pools/${pool.id}/tasks?**`);
  // A failed page retains its prefix and can be retried without duplicates.
  let failed = false;
  await page.route(`**/pools/${pool.id}/tasks?**`, async (route) => {
    if (!failed && new URL(route.request().url()).searchParams.has("cursor")) {
      failed = true;
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Refresh / resume" }).click();
  await expect(page.locator("#all-load-progress")).toContainText(
    "250 of 10,000 loaded · incomplete",
  );
  await page.getByRole("button", { name: "Retry loading", exact: true }).click();
  await expect(page.locator("#all-load-progress")).toContainText("All 10,000 rows loaded", {
    timeout: 60000,
  });
  await page.unroute(`**/pools/${pool.id}/tasks?**`);
  // A response for an obsolete filter must never enter the replacement view.
  let pending = false;
  release = undefined;
  await page.route(`**/pools/${pool.id}/tasks?**`, async (route) => {
    const url = new URL(route.request().url());
    if (!pending && !url.searchParams.get("filter") && url.searchParams.has("cursor")) {
      pending = true;
      const response = await route.fetch();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Refresh / resume" }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByLabel("Task filter").fill("a = 1");
  await page.getByRole("button", { name: "Apply filter", exact: true }).click();
  release!();
  await expect(page.locator("#all-load-progress")).toContainText("All 2,000 rows loaded", {
    timeout: 60000,
  });
  for (const cell of await page
    .locator('.tabulator-row .tabulator-cell[tabulator-field="input:a"]')
    .allTextContents())
    expect(cell).toBe("1");
  await page.unroute(`**/pools/${pool.id}/tasks?**`);
  // All export formats use the same order, independently of loaded selection scope.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const filteredIds = expected.filter((r) => r.data.a === 1).map((r) => r.task_id);
  for (const format of ["csv", "json", "ndjson"]) {
    await page.getByRole("combobox", { name: "Format", exact: true }).selectOption(format);
    const ready = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    let text = "";
    for await (const chunk of (await (await ready).createReadStream())!) text += chunk.toString();
    const ids =
      format === "csv"
        ? text
            .trim()
            .split(/\r?\n/)
            .slice(1)
            .map((line) => line.split(",")[0])
        : (format === "json"
            ? JSON.parse(text).rows
            : text
                .trim()
                .split("\n")
                .slice(1)
                .map((line) => JSON.parse(line))
          ).map((r: any) => r.task_id);
    expect(ids).toEqual(filteredIds);
  }
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Close dialog" }).click();
  // Header sorting does not discard an active editor.
  const cell = page.locator('.tabulator-row .tabulator-cell[tabulator-field="input:b"]').first();
  await cell.dblclick();
  await b.dispatchEvent("click");
  await expect(
    page.getByText("Sorting will apply after edits are saved or discarded.", { exact: true }),
  ).toBeVisible();
  await cell.locator("input").press("Escape");
  await expect(b).toContainText("↑ 1");
  // Discarding a failed edit also releases its queued sort and reloads saved values.
  await page.route("**/admin-api/v1/tasks/*", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue(),
  );
  await cell.dblclick();
  await cell.locator("input").fill("999");
  await a.dispatchEvent("click");
  await cell.locator("input").press("Enter");
  await expect(page.getByRole("heading", { name: "Edit not saved", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard / reload", exact: true }).click();
  await expect(a).toContainText("↓ 1");
  await expect(page.locator("#all-load-progress")).toContainText("All 2,000 rows loaded", {
    timeout: 60000,
  });
  await expect(
    page.locator('.tabulator-row .tabulator-cell[tabulator-field="input:b"]').first(),
  ).not.toHaveText("999");
  await page.unroute("**/admin-api/v1/tasks/*");
  // Leaving All restores the previous live-refresh setting.
  await page.getByLabel("Page size").selectOption("50");
  await expect(page.getByLabel("Live refresh")).toBeEnabled();
  await page.getByLabel("Live refresh").check();
  await page.getByLabel("Page size").selectOption("all");
  await expect(page.getByLabel("Live refresh")).toBeDisabled();
  await page.getByLabel("Page size").selectOption("50");
  await expect(page.getByLabel("Live refresh")).toBeChecked();
  // Administrator definitions are saved before building and can be deleted.
  await page.getByRole("button", { name: "Pools & profiles", exact: true }).click();
  const poolRow = page
    .locator("tr")
    .filter({ has: page.getByLabel(`${slug} name`, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Claim sort indexes", exact: true }) });
  await poolRow.getByRole("button", { name: "Claim sort indexes", exact: true }).click();
  await page.getByLabel("Index name", { exact: true }).fill("Browser order");
  await page.getByLabel("Index sort field", { exact: true }).selectOption("a");
  await page.getByRole("button", { name: "Save index definition", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("unbuilt");
  await page.getByRole("button", { name: "Build index", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rebuild index", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete index", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("No claim sort indexes configured.");
  expect(errors).toEqual([]);
});
