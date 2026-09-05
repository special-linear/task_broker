import { test, expect, type APIRequestContext } from "@playwright/test";
const meta = () => ({
  request_id: crypto.randomUUID(),
  request_created_at: new Date().toISOString(),
});
async function admin(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/admin-api/v1${path}`, {
    headers: { Origin: "http://127.0.0.1:8787", "X-Task-Broker": "1" },
    data,
  });
  const result = await response.json();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.data;
}
test("browser task creation, durable inline editing, result reporting and export", async ({
  page,
  request,
}) => {
  const slug = `browser-${crypto.randomUUID().slice(0, 8)}`;
  await admin(request, "/bootstrap", meta());
  const family = await admin(request, "/families", {
    ...meta(),
    slug,
    name: slug,
  });
  const pool = await admin(request, "/pools", {
    ...meta(),
    family_id: family.id,
    name: "Browser experiment",
    fields: [
      { key: "n", label: "n", type: "integer", required: true },
      {
        key: "diameter",
        label: "Diameter",
        type: "integer",
        kind: "result",
        pointer: "/diameter",
      },
    ],
  });
  await page.addInitScript((id) => localStorage.setItem("task-broker:last-pool", id), pool.id);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/admin/");
  await expect(
    page.getByRole("heading", { name: "Browser experiment", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "+ Add task", exact: true }).click();
  await page.getByLabel("Task ID", { exact: true }).fill("browser-task");
  await page.getByLabel("n", { exact: true }).fill("4");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(page.locator('.tabulator-cell[tabulator-field="input:n"]')).toHaveText("4");
  await page.locator('.tabulator-cell[tabulator-field="input:n"]').dblclick();
  await page.locator('.tabulator-cell[tabulator-field="input:n"] input').fill("7");
  await page.locator('.tabulator-cell[tabulator-field="input:n"] input').press("Enter");
  await expect(page.getByText(/^Saved ·/)).toBeVisible();
  await page.reload();
  await expect(page.locator('.tabulator-cell[tabulator-field="input:n"]')).toHaveText("7");
  const key = await admin(request, "/keys", {
    ...meta(),
    family_id: family.id,
    label: "Browser test worker",
  });
  const claimResponse = await request.post("/api/v1/claim", {
    headers: { Authorization: `Bearer ${key.key}` },
    data: { ...meta(), pool: slug, worker_id: "browser-test" },
  });
  const claimed = await claimResponse.json();
  expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
  const t = claimed.data.tasks[0];
  const reportResponse = await request.post("/api/v1/report", {
    headers: { Authorization: `Bearer ${key.key}` },
    data: {
      ...meta(),
      pool: slug,
      worker_id: "browser-test",
      items: [
        {
          item_id: "item",
          task_id: t.task_id,
          attempt_id: t.attempt_id,
          lease_token: t.lease_token,
          lease_generation: t.lease_generation,
          instance_epoch: t.instance_epoch,
          outcome: "success",
          result: { diameter: 49 },
        },
      ],
    },
  });
  expect((await reportResponse.json()).data.items[0].status).toBe("applied");
  await page.getByRole("button", { name: "Refresh / resume" }).click();
  await expect(page.locator('.tabulator-cell[tabulator-field="result:diameter"]')).toHaveText("49");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  const stream = await file.createReadStream();
  let csv = "";
  for await (const chunk of stream!) csv += chunk.toString();
  expect(csv).toContain("diameter");
  expect(csv).toContain("49");
  expect(csv).toContain("completed");
  expect(errors).toEqual([]);
});

test("two sessions preserve a conflicting draft, recover a lost response, and stage pasted edits", async ({
  browser,
  request,
}) => {
  const slug = `conflict-${crypto.randomUUID().slice(0, 8)}`;
  await admin(request, "/bootstrap", meta());
  const family = await admin(request, "/families", { ...meta(), slug, name: slug });
  const pool = await admin(request, "/pools", {
    ...meta(),
    family_id: family.id,
    name: slug,
    fields: [{ key: "n", label: "n", type: "integer", required: true }],
  });
  await admin(request, `/pools/${pool.id}/tasks`, { ...meta(), task_id: "one", data: { n: 1 } });
  await admin(request, `/pools/${pool.id}/tasks`, { ...meta(), task_id: "two", data: { n: 2 } });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(
    contexts.map(async (context) => {
      await context.addInitScript(
        (id) => localStorage.setItem("task-broker:last-pool", id),
        pool.id,
      );
      const page = await context.newPage();
      await page.goto("http://127.0.0.1:8787/admin/tasks");
      await expect(page.getByRole("heading", { name: slug, exact: true })).toBeVisible();
      return page;
    }),
  );
  try {
    const [first, second] = pages;
    const edit = async (page: typeof first, value: string) => {
      const cell = page
        .locator(".tabulator-row")
        .filter({ hasText: "one" })
        .locator('[tabulator-field="input:n"]');
      await cell.dblclick();
      await cell.locator("input").fill(value);
      await cell.locator("input").press("Enter");
    };
    await edit(first, "3");
    await expect(first.getByText(/^Saved /)).toBeVisible();
    await edit(second, "4");
    await expect(second.getByRole("heading", { name: "Edit not saved" })).toBeVisible();
    await expect(second.getByText("Your attempted value")).toBeVisible();
    await expect(second.locator("dialog pre").last()).toContainText("4");
    await second.getByRole("button", { name: "Retry against this revision", exact: true }).click();
    await expect(
      second
        .locator(".tabulator-row")
        .filter({ hasText: "one" })
        .locator('[tabulator-field="input:n"]'),
    ).toHaveText("4");
    await first.getByRole("button", { name: "Refresh / resume" }).click();
    await expect(
      first
        .locator(".tabulator-row")
        .filter({ hasText: "one" })
        .locator('[tabulator-field="input:n"]'),
    ).toHaveText("4");
    const sent: string[] = [];
    let lose = true;
    await first.route("**/admin-api/v1/tasks/*", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      sent.push(route.request().postData()!);
      if (lose) {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await edit(first, "5");
    await expect(first.getByRole("heading", { name: "Edit not saved" })).toBeVisible();
    await first.getByRole("button", { name: "Retry same operation" }).click();
    await expect(first.getByText(/^Saved /)).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    await first.unroute("**/admin-api/v1/tasks/*");
    const cell = first
      .locator(".tabulator-row")
      .filter({ hasText: "one" })
      .locator('[tabulator-field="input:n"]');
    await cell.click();
    await cell.evaluate((element) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "9007199254740993\n8");
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: clipboard });
      element.dispatchEvent(event);
    });
    await expect(first.getByText(/2 unsaved edits/)).toBeVisible();
    const before = await request.get(`/admin-api/v1/pools/${pool.id}/tasks`);
    expect((await before.json()).data.rows[0].data.n).toBe(5);
    await first.getByRole("button", { name: "Save drafts", exact: true }).click();
    await first.getByRole("button", { name: "Save reviewed drafts", exact: true }).click();
    await expect(
      first
        .locator(".tabulator-row")
        .filter({ hasText: "one" })
        .locator('[tabulator-field="input:n"]'),
    ).toHaveText("9007199254740993");
    await first.reload();
    await expect(
      first
        .locator(".tabulator-row")
        .filter({ hasText: "two" })
        .locator('[tabulator-field="input:n"]'),
    ).toHaveText("8");
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test("shared views restore profile, filter and columns; live polling pauses for editors, hidden tabs and inactivity", async ({
  browser,
  request,
}) => {
  const slug = `views-${crypto.randomUUID().slice(0, 8)}`;
  await admin(request, "/bootstrap", meta());
  const f = await admin(request, "/families", { ...meta(), slug, name: slug });
  const pool = await admin(request, "/pools", {
    ...meta(),
    family_id: f.id,
    name: slug,
    fields: [{ key: "n", label: "n", type: "integer" }],
  });
  for (let n = 1; n <= 2; n++)
    await admin(request, `/pools/${pool.id}/tasks`, {
      ...meta(),
      task_id: `task-${n}`,
      data: { n },
    });
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    for (const context of [first, second])
      await context.addInitScript(
        (id) => localStorage.setItem("task-broker:last-pool", id),
        pool.id,
      );
    const page = await first.newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto("http://127.0.0.1:8787/admin/tasks");
    await expect(page.locator(".tabulator-row")).toHaveCount(2);
    await page.getByLabel("Profile context").selectOption(pool.profile_id);
    await page.getByLabel("Task filter").fill("n >= 1");
    await page.getByRole("button", { name: "Apply filter", exact: true }).click();
    await page.getByLabel("Page size").selectOption("50");
    await page.locator('.tabulator-col[tabulator-field="task_id"]').click();
    await expect(
      page.locator(".tabulator-row").first().locator('[tabulator-field="task_id"]'),
    ).toHaveText("task-2");
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByLabel("Enabled", { exact: true }).uncheck();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Saved views", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Shared analysis");
    await page.getByLabel("Shared with administrators").check();
    await page.getByRole("button", { name: "Save current view" }).click();
    await expect(page.getByText("View saved.", { exact: true })).toBeVisible();
    const other = await second.newPage();
    await other.clock.install();
    await other.goto("http://127.0.0.1:8787/admin/tasks");
    await expect(other.locator(".tabulator-row")).toHaveCount(2);
    await other.getByRole("button", { name: "Saved views", exact: true }).click();
    await other.getByRole("button", { name: /^Shared analysis/ }).click();
    await expect(other.getByLabel("Profile context")).toHaveValue(pool.profile_id);
    await expect(other.getByLabel("Task filter")).toHaveValue("n >= 1");
    await expect(other.getByLabel("Page size")).toHaveValue("50");
    await expect(
      other.locator(".tabulator-row").first().locator('[tabulator-field="task_id"]'),
    ).toHaveText("task-2");
    await expect(other.locator('.tabulator-col[tabulator-field="enabled"]')).toBeHidden();
    let reads = 0;
    other.on("request", (r) => {
      if (r.url().includes(`/pools/${pool.id}/tasks?`)) reads++;
    });
    await other.getByLabel("Live refresh").check();
    await other.clock.fastForward(11000);
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(other.getByText(/updated /).first()).toBeVisible();
    const cell = other.locator(".tabulator-row").first().locator('[tabulator-field="input:n"]');
    await cell.dblclick();
    await cell.locator("input").fill("draft");
    const editingReads = reads;
    await other.clock.fastForward(11000);
    expect(reads).toBe(editingReads);
    await expect(cell.locator("input")).toHaveValue("draft");
    await cell.locator("input").press("Escape");
    await other.evaluate(() =>
      Object.defineProperty(document, "hidden", { get: () => true, configurable: true }),
    );
    const hiddenReads = reads;
    await other.clock.fastForward(11000);
    expect(reads).toBe(hiddenReads);
    await other.evaluate(() =>
      Object.defineProperty(document, "hidden", { get: () => false, configurable: true }),
    );
    await other.clock.fastForward(901000);
    expect(reads).toBe(hiddenReads);
    await other.getByRole("button", { name: "Refresh / resume" }).click();
    await expect.poll(() => reads).toBeGreaterThan(hiddenReads);
  } finally {
    await first.close();
    await second.close();
  }
});

test("AUTH-07: hostile input values and column labels render as text", async ({
  page,
  request,
}) => {
  const slug = `escape-${crypto.randomUUID().slice(0, 8)}`,
    label = '<img src=x onerror="window.headerInjected=true">',
    value = '<svg onload="window.cellInjected=true"></svg>';
  await admin(request, "/bootstrap", meta());
  const f = await admin(request, "/families", { ...meta(), slug, name: slug }),
    pool = await admin(request, "/pools", {
      ...meta(),
      family_id: f.id,
      name: slug,
      fields: [{ key: "text", label, type: "string" }],
    });
  await admin(request, `/pools/${pool.id}/tasks`, { ...meta(), data: { text: value } });
  await page.addInitScript((id) => localStorage.setItem("task-broker:last-pool", id), pool.id);
  await page.goto("/admin/tasks");
  await expect(page.locator('.tabulator-col[tabulator-field="input:text"]')).toHaveText(label);
  await expect(page.locator('.tabulator-cell[tabulator-field="input:text"]')).toHaveText(value);
  await expect(
    page.locator('[tabulator-field="input:text"] img, [tabulator-field="input:text"] svg'),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Boolean((window as any).headerInjected || (window as any).cellInjected),
    ),
  ).toBe(false);
});
