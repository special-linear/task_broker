import { api, operation } from "./api";
import { button, dialog, el, labeled, stringify } from "./dom";

export function startHere(
  main: HTMLElement,
  create: () => unknown,
  openPool: (id: string) => Promise<void>,
) {
  main.append(
    el("h1", {}, "Start here"),
    el(
      "p",
      { class: "muted" },
      "Create experiments in the browser. Run computations on your own Python workers. Review and download the results here.",
    ),
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "Your first experiment"),
      el(
        "ol",
        {},
        el("li", {}, "Create a family and pool; define typed input and result columns."),
        el("li", {}, "Add tasks or import a table. Review large changes before saving."),
        el("li", {}, "Issue a family key and put it in your worker environment."),
        el("li", {}, "Run the Python client, then refresh Tasks and export your results."),
      ),
      button("Create a pool", create, "primary"),
    ),
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "Python downloads"),
      el(
        "a",
        { href: "/admin/downloads/task_pool.py", download: "task_pool.py" },
        "Download task_pool.py",
      ),
      el(
        "p",
        {},
        "Python 3.10 or newer. The client uses only the standard library; no package installation is needed.",
      ),
      el(
        "a",
        { href: "/admin/downloads/minimal_worker.py", download: "minimal_worker.py" },
        "Download the minimal worker",
      ),
    ),
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "Disposable end-to-end demo"),
      el(
        "p",
        {},
        "Create one temporary task, run a tiny Python command against the public compute API, and verify the returned result. Existing experiments are untouched.",
      ),
      button("Create disposable demo", () => demo(openPool), "primary"),
    ),
  );
}
async function demo(openPool: (id: string) => Promise<void>) {
  const d = dialog("Disposable Python demo"),
    status = el("p", {}, "Creating a temporary family, pool and task…");
  d.content.append(status);
  const suffix = crypto.randomUUID().slice(0, 8),
    slug = `demo-${suffix}`;
  const family = await api("/families", {
      ...operation(),
      slug,
      name: `Disposable demo ${suffix}`,
    }),
    pool = await api("/pools", {
      ...operation(),
      family_id: family.id,
      name: `Demo ${suffix}`,
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
  await api(`/pools/${pool.id}/tasks`, { ...operation(), task_id: "demo-square", data: { n: 7 } });
  const issued = await api("/keys", {
      ...operation(),
      family_id: family.id,
      label: `Temporary demo ${suffix}`,
    }),
    settings = await api("/diagnostics");
  if (!issued.secret_available)
    throw new Error(
      "The key creation response was lost and its receipt is redacted. Rotate this temporary key from API keys.",
    );
  const origin =
      settings.environment === "local" ? location.origin : `https://${settings.broker_hostname}`,
    secret = el("input", { readOnly: true, value: issued.key, style: "width:100%" });
  status.textContent =
    "Task created. Download task_pool.py into your working directory, then set the environment variables and run the command.";
  const snippet = el(
    "pre",
    {},
    `# PowerShell\n$env:TASK_MANAGER_URL='${origin}'\n$env:TASK_MANAGER_KEY='${issued.key}'\n\n# Linux / macOS\nexport TASK_MANAGER_URL='${origin}'\nexport TASK_MANAGER_KEY='${issued.key}'`,
  );
  d.content.append(
    el(
      "a",
      { href: "/admin/downloads/task_pool.py", download: "task_pool.py" },
      "Download the Python client",
    ),
    labeled("Temporary family key (shown once)", secret),
    button("Copy temporary key", () => navigator.clipboard.writeText(issued.key)),
    snippet,
    el(
      "pre",
      {},
      `python -c "from task_pool import TaskClient; c=TaskClient.from_env('${slug}'); tasks=c.claim(1); [t.complete({'diameter': int(t.data['n'])**2}) for t in tasks]; print('Completed', len(tasks))"`,
    ),
    button("Verify Python result", async () => {
      const page = await api(`/pools/${pool.id}/tasks`),
        row = page.rows[0];
      status.textContent =
        row.status === "completed" && row.result?.diameter === 49
          ? "Verified: Python claimed the task and returned Diameter = 49. You can open Tasks and export the result."
          : `Waiting for Python. Current state: ${row.status}.`;
      if (row.status === "completed") d.content.append(el("pre", {}, stringify(row.result)));
    }),
    button("Open demo results", () => openPool(pool.id)),
    button(
      "Revoke key and archive demo",
      async () => {
        await api(`/keys/${issued.id}/hard-revoke`, {
          ...operation(),
          reason: "Disposable demo cleanup",
        });
        const current = await api(`/pools/${pool.id}`);
        await api(
          `/pools/${pool.id}`,
          { ...operation(), expected_revision: current.config_revision, patch: { archived: true } },
          "PATCH",
        );
        secret.value = "";
        snippet.textContent = "Temporary key revoked.";
        issued.key = undefined;
        status.textContent =
          "Demo archived; temporary credentials revoked. Its task and attempt history remain available.";
      },
      "danger",
    ),
  );
  d.dialog.addEventListener("close", () => {
    secret.value = "";
    snippet.textContent = "";
    issued.key = undefined;
  });
}
