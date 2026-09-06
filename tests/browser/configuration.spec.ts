import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
const meta = () => ({
  request_id: crypto.randomUUID(),
  request_created_at: new Date().toISOString(),
});
async function admin(request: APIRequestContext, path: string, data?: unknown) {
  const response =
    data === undefined
      ? await request.get(`/admin-api/v1${path}`)
      : await request.post(`/admin-api/v1${path}`, {
          headers: { Origin: "http://127.0.0.1:8787", "X-Task-Broker": "1" },
          data,
        });
  const result = await response.json();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.data;
}
const panel = (page: Page, title: string) =>
  page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const row = (page: Page, title: string, name: string) =>
  panel(page, title)
    .getByRole("row")
    .filter({ has: page.getByRole("textbox", { name: `${name} name`, exact: true }) });

test("a result column created in the editor maps the matching object property", async ({
  page,
  request,
}) => {
  await admin(request, "/bootstrap", meta());
  const slug = `mapping-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/admin/pools");
  await page.getByRole("main").getByRole("button", { name: "+ Create pool", exact: true }).click();
  const d = page.getByRole("dialog");
  await d.getByRole("combobox", { name: "Family", exact: true }).selectOption("new");
  await d.getByLabel("New family name").fill(slug);
  await d.getByLabel("New family route").fill(slug);
  await d.getByLabel("Pool name", { exact: true }).fill(slug);
  await d.getByLabel("Worker route suffix").fill("diameters");
  await d.getByRole("button", { name: "+ Add column" }).click();
  const column = d.locator(".fields-list > .panel").last();
  await column.getByLabel("Field key", { exact: true }).fill("diameter");
  await column.getByLabel("Field type", { exact: true }).selectOption("integer");
  await column.getByLabel("Field kind", { exact: true }).selectOption("result");
  const pointer = column.getByLabel("Result JSON Pointer", { exact: true });
  await expect(pointer).toBeVisible();
  await expect(pointer).toHaveValue("/diameter");
  await column.getByLabel("Field key", { exact: true }).fill("a/b~c");
  await expect(pointer).toHaveValue("/a~1b~0c");
  await column.getByLabel("Field key", { exact: true }).fill("diameter");
  await d.getByRole("button", { name: "Create pool", exact: true }).click();
  await expect(d).toHaveCount(0);
  const family = (await admin(request, "/families")).rows.find((f: any) => f.slug === slug);
  const pool = (await admin(request, `/pools?family_id=${family.id}`)).rows[0];
  const fields = (await admin(request, `/pools/${pool.id}/fields`)).fields;
  expect(fields.find((f: any) => f.key === "diameter")).toMatchObject({
    type: "integer",
    kind: "result",
    pointer: "/diameter",
  });
  await admin(request, `/pools/${pool.id}/tasks`, { ...meta(), data: { n: 2 } });
  const key = await admin(request, "/keys", { ...meta(), family_id: family.id, label: "mapping" });
  const compute = async (path: string, body: unknown) => {
    const response = await request.post(`/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${key.key}` },
      data: body,
    });
    const result = await response.json();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.data;
  };
  const envelope = { pool: `${slug}/diameters`, worker_id: "mapping-test" };
  const t = (await compute("claim", { ...meta(), ...envelope })).tasks[0];
  const report = await compute("report", {
    ...meta(),
    ...envelope,
    items: [
      {
        item_id: "result",
        task_id: t.task_id,
        attempt_id: t.attempt_id,
        lease_token: t.lease_token,
        lease_generation: t.lease_generation,
        instance_epoch: t.instance_epoch,
        outcome: "success",
        result: { diameter: Number(t.data.n) ** 2 },
        runtime_seconds: 0.0123456789,
        runtime_origin: "received",
      },
    ],
  });
  expect(report.items[0].status, JSON.stringify(report)).toBe("applied");
  const tasks = await admin(request, `/pools/${pool.id}/tasks`);
  expect(tasks.rows[0].result).toEqual({ diameter: 4 });
});

test("editing fields preserves explicit blank and custom result pointers", async ({
  page,
  request,
}) => {
  await admin(request, "/bootstrap", meta());
  const slug = `pointers-${crypto.randomUUID().slice(0, 8)}`;
  const family = await admin(request, "/families", { ...meta(), slug, name: slug });
  const pool = await admin(request, "/pools", {
    ...meta(),
    family_id: family.id,
    name: slug,
    fields: [
      { key: "whole", label: "Whole", type: "json", kind: "result", pointer: "" },
      {
        key: "nested",
        label: "Nested",
        type: "integer",
        kind: "result",
        pointer: "/metrics/value",
      },
    ],
  });
  await page.goto("/admin/pools");
  await row(page, "Physical pools", slug)
    .getByRole("button", { name: "Columns", exact: true })
    .click();
  const d = page.getByRole("dialog");
  const columns = d.locator(".fields-list > .panel");
  await expect(columns.nth(0).getByLabel("Result JSON Pointer")).toBeVisible();
  await expect(columns.nth(0).getByLabel("Result JSON Pointer")).toHaveValue("");
  await columns.nth(0).getByLabel("Field key", { exact: true }).fill("renamed_whole");
  await columns.nth(1).getByLabel("Field key", { exact: true }).fill("renamed_nested");
  await expect(columns.nth(0).getByLabel("Result JSON Pointer")).toHaveValue("");
  await expect(columns.nth(1).getByLabel("Result JSON Pointer")).toHaveValue("/metrics/value");
  await d.getByRole("button", { name: "+ Add column" }).click();
  const added = columns.last();
  await added.getByLabel("Field key", { exact: true }).fill("manual");
  await added.getByLabel("Field kind", { exact: true }).selectOption("result");
  await added.getByLabel("Result JSON Pointer").fill("");
  await added.getByLabel("Field key", { exact: true }).fill("manual_root");
  await expect(added.getByLabel("Result JSON Pointer")).toHaveValue("");
  const previewRequest = page.waitForRequest((r) =>
    r.url().endsWith(`/pools/${pool.id}/fields/preview`),
  );
  await d.getByRole("button", { name: "Preview schema change" }).click();
  expect((await previewRequest).postDataJSON().fields.map((f: any) => f.pointer)).toEqual([
    "",
    "/metrics/value",
    "",
  ]);
  await expect(page.getByRole("dialog", { name: "Review schema changes" })).toBeVisible();
});

test("pool creation exposes routes and relationships, defaults and archive/restore", async ({
  page,
  request,
}, testInfo) => {
  await admin(request, "/bootstrap", meta());
  const slug = `ui-${crypto.randomUUID().slice(0, 8)}`;
  const familyName = `Calculations ${slug}`;
  const poolName = `SL(n,Z/mZ) diameters ${slug}`;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/admin/pools");
  await page.getByRole("main").getByRole("button", { name: "+ Create pool", exact: true }).click();
  let d = page.getByRole("dialog");
  await d.getByRole("combobox", { name: "Family", exact: true }).selectOption("new");
  await d.getByLabel("New family name").fill(familyName);
  await d.getByLabel("New family route").fill(slug);
  await d.getByLabel("Pool name", { exact: true }).fill(poolName);
  await d.getByLabel("Worker route suffix").fill("diameters");
  await expect(d.locator("code")).toHaveText(`${slug}/diameters`);
  await d.getByRole("button", { name: "Create pool", exact: true }).click();
  await expect(d).toHaveCount(0);
  await expect(row(page, "Physical pools", poolName)).toContainText(familyName);
  await expect(row(page, "Physical pools", poolName)).toContainText(`${slug}/diameters`);
  await expect(row(page, "Distribution profiles", poolName)).toContainText(familyName);
  await expect(row(page, "Distribution profiles", poolName)).toContainText(
    `Family default: ${slug}`,
  );
  await row(page, "Distribution profiles", poolName)
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  d = page.getByRole("dialog");
  await expect(d).toContainText(familyName);
  await expect(d).toContainText(`Target pool: ${poolName}`);
  await expect(d).toContainText(`${slug}/diameters`);
  await d.getByRole("button", { name: "Close dialog" }).click();
  const families = await admin(request, "/families");
  const family = families.rows.find((f: any) => f.slug === slug);
  const pools = await admin(request, `/pools?family_id=${family.id}`);
  const first = pools.rows[0];
  const secondName = `Spectra ${slug}`;
  await page.getByRole("main").getByRole("button", { name: "+ Create pool", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByRole("combobox", { name: "Family", exact: true }).selectOption(family.id);
  await expect(d.getByLabel("New family name")).toBeHidden();
  await d.getByLabel("Pool name", { exact: true }).fill(secondName);
  await d.getByLabel("Worker route suffix").fill("spectra");
  await d.getByRole("button", { name: "Create pool", exact: true }).click();
  await expect(d).toHaveCount(0);
  const second = (await admin(request, `/profiles?family_id=${family.id}`)).rows.find(
    (p: any) => p.slug === "spectra",
  );
  await row(page, "Families", familyName)
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  d = page.getByRole("dialog");
  await d.getByRole("combobox", { name: "Default profile", exact: true }).selectOption(second.id);
  await d.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(row(page, "Distribution profiles", secondName)).toContainText(
    `Family default: ${slug}`,
  );
  await expect(row(page, "Distribution profiles", poolName)).not.toContainText("Family default:");
  await admin(request, `/pools/${first.id}/tasks`, { ...meta(), task_id: "keep", data: { n: 7 } });
  await row(page, "Physical pools", poolName)
    .getByRole("button", { name: "Delete…", exact: true })
    .click();
  d = page.getByRole("dialog");
  await expect(d).toContainText("The pool contains tasks");
  await expect(d.getByRole("button", { name: "Delete permanently" })).toHaveCount(0);
  await d.getByRole("button", { name: "Archive instead" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive item", exact: true }).click();
  await expect(row(page, "Physical pools", poolName)).toHaveCount(0);
  await expect(
    page.locator(".sidebar").getByRole("button").filter({ hasText: poolName }),
  ).toHaveCount(0);
  await page.getByRole("main").getByLabel("Show archived", { exact: true }).check();
  await expect(row(page, "Physical pools", poolName)).toContainText("Archived");
  await page.reload();
  await expect(page.getByRole("main").getByLabel("Show archived", { exact: true })).toBeChecked();
  await row(page, "Physical pools", poolName)
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Restore item", exact: true }).click();
  await expect(row(page, "Physical pools", poolName).getByRole("checkbox")).not.toBeChecked();
  await row(page, "Physical pools", secondName)
    .getByRole("button", { name: "Delete…", exact: true })
    .click();
  d = page.getByRole("dialog");
  await expect(d).toContainText("These unused profiles will also be deleted");
  await expect(d).toContainText("will have no default profile");
  await d.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(row(page, "Physical pools", secondName)).toHaveCount(0);
  await expect(row(page, "Distribution profiles", secondName)).toHaveCount(0);
  await expect(row(page, "Families", familyName)).toContainText("No default profile");
  await page.screenshot({ path: testInfo.outputPath("configuration.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("unused profiles, empty pools and families can be removed through reviewed dialogs", async ({
  page,
  request,
}) => {
  await admin(request, "/bootstrap", meta());
  const name = `Delete ${crypto.randomUUID().slice(0, 8)}`;
  const family = await admin(request, "/families", {
    ...meta(),
    slug: name.replace(" ", "-"),
    name,
  });
  await admin(request, "/pools", { ...meta(), family_id: family.id, name, fields: [] });
  await page.goto("/admin/pools");
  await row(page, "Distribution profiles", name)
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive item", exact: true }).click();
  await expect(row(page, "Distribution profiles", name)).toHaveCount(0);
  await page.getByRole("main").getByLabel("Show archived", { exact: true }).check();
  await row(page, "Distribution profiles", name)
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Restore item", exact: true }).click();
  await expect(row(page, "Distribution profiles", name).getByRole("checkbox")).not.toBeChecked();
  await row(page, "Families", name).getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive item", exact: true }).click();
  await page.getByRole("main").getByLabel("Show archived", { exact: true }).uncheck();
  for (const table of ["Families", "Physical pools", "Distribution profiles"])
    await expect(row(page, table, name)).toHaveCount(0);
  await page.getByRole("main").getByLabel("Show archived", { exact: true }).check();
  await row(page, "Families", name).getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Restore item", exact: true }).click();
  for (const table of ["Distribution profiles", "Physical pools", "Families"]) {
    await row(page, table, name).getByRole("button", { name: "Delete…", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete permanently", exact: true })
      .click();
    await expect(row(page, table, name)).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.getByText("Unknown pool route.", { exact: true })).toHaveCount(0);
});
