import {
  defaultSorts,
  promoteSort,
  sortChoice,
  sortKeys,
  taskComparator,
  type SortSpec,
} from "../shared/sort";
import "./styles.css";
import { api, apiRows, ApiError, operation } from "./api";
import {
  button,
  dialog,
  download,
  el,
  errorBox,
  labeled,
  notifyError,
  select,
  stringify,
  toast,
} from "./dom";
import { TaskGrid, inputValue } from "./grid";
import type { Field } from "../shared/core";
import type { TaskRow } from "../shared/contracts";
import { importDialog, exportDialog, parseTable } from "./transfer";
import { startHere } from "./onboarding";
import { configurationScreen, createPoolDialog, keysScreen, settingsScreen } from "./screens";
type Draft = {
  row: TaskRow;
  key: string;
  value: unknown;
  body?: any;
  error?: unknown;
  staged?: boolean;
};
const state = {
  families: [] as any[],
  pools: [] as any[],
  profiles: [] as any[],
  poolId: "",
  profileId: "",
  fields: [] as Field[],
  rows: [] as TaskRow[],
  filter: "",
  sorts: defaultSorts(),
  pageSize: 100 as number | "all",
  cursor: null as string | null,
  back: [] as (string | null)[],
  next: null as string | null,
  grid: null as TaskGrid | null,
  drafts: new Map<string, Draft>(),
  saving: 0,
  lastActivity: Date.now(),
  live: false,
  screen: "tasks",
  lastUpdated: "",
  views: [] as any[],
};
let main: HTMLElement,
  nav: HTMLElement,
  poolNav: HTMLElement,
  status: HTMLElement,
  selectedLabel: HTMLElement;
export const refreshConfig = async () => {
  const [families, pools, profiles, views] = await Promise.all([
    apiRows("/families"),
    apiRows("/pools"),
    apiRows("/profiles"),
    apiRows("/views"),
  ]);
  state.families = families.rows;
  state.pools = pools.rows;
  state.profiles = profiles.rows;
  state.views = views.rows;
  renderPoolNav();
};
async function start() {
  const app = document.querySelector("#app")!;
  nav = el("nav", { class: "nav", "aria-label": "Main navigation" });
  poolNav = el("nav", { class: "pool-nav", "aria-label": "Pools" });
  main = el("main", { class: "main" });
  app.append(
    el(
      "div",
      { class: "shell" },
      el(
        "aside",
        { class: "sidebar" },
        el("div", { class: "brand" }, el("span", { class: "brand-mark" }, "▦"), "Task Broker"),
        nav,
        el("div", {}, el("p", { class: "eyebrow" }, "Your pools"), poolNav),
        el(
          "div",
          { class: "sidebar-footer" },
          "Your experiments, organized.",
          el("br"),
          "Computation runs on your workers.",
        ),
      ),
      main,
    ),
  );
  for (const [key, label] of [
    ["start", "Start here"],
    ["tasks", "Tasks"],
    ["pools", "Pools & profiles"],
    ["keys", "API keys"],
    ["activity", "Activity"],
    ["settings", "Settings"],
  ])
    nav.append(button(label, () => navigate(key)));
  try {
    const me = await api("/me");
    if (me.installation.setup_status === "closed") {
      const panel = el(
        "div",
        { class: "empty" },
        el("h1", {}, "Welcome to Task Broker"),
        el(
          "p",
          {},
          "Your identity is verified. Initialize the empty installation to begin organizing experiments.",
        ),
        button(
          "Initialize installation",
          async () => {
            await api("/bootstrap", operation());
            await startAgain();
          },
          "primary",
        ),
      );
      main.append(panel);
      return;
    }
    await refreshConfig();
    state.poolId = localStorage.getItem("task-broker:last-pool") ?? state.pools[0]?.id ?? "";
    if (!state.pools.some((p) => p.id === state.poolId)) state.poolId = state.pools[0]?.id ?? "";
    await navigate(location.pathname.replace(/^\/admin\/?/, "").split("/")[0] || "tasks", true);
  } catch (e) {
    main.replaceChildren(
      el("h1", {}, "Connection unavailable"),
      errorBox(e),
      button("Retry", startAgain),
    );
  }
}
async function startAgain() {
  state.grid?.destroy();
  state.grid = null;
  document.querySelector("#app")!.replaceChildren();
  await start();
}
function renderPoolNav() {
  poolNav.replaceChildren();
  for (const family of state.families) {
    poolNav.append(el("small", {}, family.name));
    for (const p of state.pools.filter((p) => p.owner_family_id === family.id))
      poolNav.append(
        button(
          `${p.archived_at ? "◌" : "○"} ${p.name}`,
          async () => {
            if (!(await canLeave())) return;
            state.poolId = p.id;
            state.sorts = defaultSorts();
            state.profileId = "";
            state.cursor = null;
            state.back = [];
            localStorage.setItem("task-broker:last-pool", p.id);
            await navigate("tasks", true);
          },
          p.id === state.poolId ? "selected" : "",
        ),
      );
  }
  poolNav.append(
    button("+ Create pool", () =>
      createPoolDialog(state.families, async (id) => {
        await refreshConfig();
        state.poolId = id;
        await navigate("tasks", true);
      }),
    ),
  );
}
async function canLeave() {
  if (!state.drafts.size) return true;
  return new Promise<boolean>((resolve) => {
    const d = dialog("Unsaved changes", true);
    d.content.append(
      el(
        "p",
        {},
        "There are edits that have not been saved. Stay here to resolve them, or discard the local drafts.",
      ),
      button("Stay", () => {
        resolve(false);
        d.dialog.close();
      }),
      button(
        "Discard drafts",
        () => {
          state.drafts.clear();
          resolve(true);
          d.dialog.close();
        },
        "danger",
      ),
    );
    d.dialog.addEventListener("cancel", () => resolve(false));
  });
}
async function navigate(screen: string, force = false) {
  if (!force && !(await canLeave())) return;
  cancelLoad();
  deferredReload = false;
  deferredSorts = null;
  state.screen = screen;
  state.grid?.destroy();
  state.grid = null;
  main.replaceChildren();
  history.replaceState(null, "", `/admin/${screen}`);
  [...nav.querySelectorAll("button")].forEach((b, i) =>
    b.classList.toggle(
      "active",
      ["start", "tasks", "pools", "keys", "activity", "settings"][i] === screen,
    ),
  );
  renderPoolNav();
  if (screen === "start")
    startHere(
      main,
      () =>
        createPoolDialog(state.families, async (id) => {
          await refreshConfig();
          state.poolId = id;
          await navigate("tasks", true);
        }),
      async (id) => {
        await refreshConfig();
        state.poolId = id;
        await navigate("tasks", true);
      },
    );
  else if (screen === "tasks") await showTasks();
  else if (screen === "pools")
    await configurationScreen(main, state, async () => {
      await refreshConfig();
      await navigate("pools", true);
    });
  else if (screen === "keys") await keysScreen(main, state.families);
  else if (screen === "settings") await settingsScreen(main, () => navigate("settings", true));
  else if (screen === "activity") await activity();
  else await navigate("tasks", true);
}
async function showTasks() {
  if (!state.poolId) {
    main.append(
      el(
        "div",
        { class: "empty" },
        el("p", { class: "eyebrow" }, "Start here"),
        el("h1", {}, "A home for your next experiment"),
        el(
          "p",
          {},
          "Create a pool, add your inputs, and let Python workers pick up the work. Results return to the same table.",
        ),
        button(
          "Create your first pool",
          () =>
            createPoolDialog(state.families, async (id) => {
              await refreshConfig();
              state.poolId = id;
              await navigate("tasks", true);
            }),
          "primary",
        ),
        el(
          "div",
          { class: "step-grid" },
          ...[
            "1. Define your inputs",
            "2. Run a Python worker",
            "3. Explore and export results",
          ].map((t) => el("div", { class: "step" }, el("strong", {}, t))),
        ),
      ),
    );
    return;
  }
  const pool = state.pools.find((p) => p.id === state.poolId),
    title = el(
      "div",
      {},
      el("p", { class: "eyebrow" }, "Experiment workspace"),
      el("h1", {}, pool?.name ?? "Tasks"),
      el(
        "span",
        { class: "muted" },
        pool?.description || "Edit inputs, track leases, collect results.",
      ),
    );
  status = el("span", { class: "badge" }, "Loading");
  main.append(el("div", { class: "topline" }, title, status));
  const filter = el("input", {
    class: "filter",
    placeholder: "Filter: has:gpu AND n >= 4",
    value: state.filter,
    "aria-label": "Task filter",
  });
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      state.filter = filter.value;
      state.cursor = null;
      state.back = [];
      void loadPage();
    }
  });
  const profile = select(
    [
      { value: "", label: "Global status" },
      ...state.profiles
        .filter((p) => p.pool_id === state.poolId)
        .map((p) => ({
          value: p.id,
          label: `${state.families.find((f) => f.id === p.family_id)?.name} / ${p.name}`,
        })),
    ],
    state.profileId,
  );
  profile.setAttribute("aria-label", "Profile context");
  profile.onchange = () => {
    state.profileId = profile.value;
    state.cursor = null;
    void loadPage();
  };
  main.append(
    el(
      "div",
      { class: "toolbar" },
      filter,
      button("Apply filter", () => {
        state.filter = filter.value;
        state.cursor = null;
        state.back = [];
        return loadPage();
      }),
      button("Build filter", () => filterBuilder(filter)),
      profile,
    ),
  );
  selectedLabel = el(
    "span",
    { class: "muted", style: "min-width:12rem" },
    "0 selected (loaded rows)",
  );
  main.append(
    el(
      "div",
      { class: "toolbar" },
      button("+ Add task", () => taskForm()),
      button("Draft rows", () => addDraftRows()),
      button("Save drafts", saveStagedDrafts),
      button("Import / paste", () => importDialog(state.poolId, state.fields, () => loadPage())),
      button("Bulk actions", () => bulkDialog()),
      selectedLabel,
      el("span", { class: "spacer" }),
      button("Columns", columnDialog),
      button("Saved views", viewDialog),
      button("Export", () =>
        exportDialog(
          state.poolId,
          state.profileId,
          state.fields,
          state.filter,
          state.grid?.selected() ?? [],
          state.sorts,
        ),
      ),
    ),
  );
  const grid = el("div", { id: "task-grid", class: "grid-wrap" });
  main.append(
    el("div", { id: "task-sorts", class: "toolbar", "aria-label": "Sort priority" }),
    grid,
  );
  const pageSize = select(
    [
      ...[50, 100, 250].map((n) => ({ value: String(n), label: `${n} rows` })),
      { value: "all", label: "All rows" },
    ],
    String(state.pageSize),
  );
  pageSize.setAttribute("aria-label", "Page size");
  pageSize.onchange = () => {
    state.pageSize = pageSize.value === "all" ? "all" : Number(pageSize.value);
    updateLoadControls();
    state.cursor = null;
    state.back = [];
    void loadPage();
  };
  const live = el("input", {
    type: "checkbox",
    checked: state.live,
    onchange: (e: Event) => {
      state.live = (e.target as HTMLInputElement).checked;
      state.lastActivity = Date.now();
    },
  });
  live.id = "task-live-refresh";
  main.append(
    el(
      "div",
      { class: "pagination" },
      el(
        "div",
        { class: "toolbar" },
        button("← Previous", () => {
          if (state.back.length) {
            state.cursor = state.back.pop()!;
            return loadPage();
          }
        }),
        button("Next →", () => {
          if (state.next) {
            state.back.push(state.cursor);
            state.cursor = state.next;
            return loadPage();
          }
        }),
        pageSize,
        button("Cancel loading", cancelLoad),
        button("Retry loading", () => loadPage(true)),
        el("span", { id: "all-load-progress", role: "status" }),
      ),
      el(
        "div",
        { class: "toolbar" },
        labeled("Live refresh", live),
        button("Refresh / resume", () => {
          state.lastActivity = Date.now();
          return loadPage();
        }),
      ),
    ),
  );
  main.append(
    el(
      "p",
      { class: "input-note" },
      "Double-click a cell to edit. Tab moves between cells; Escape cancels. Use the task form for keyboard-accessible editing. Result columns are read-only.",
    ),
  );
  await loadPage();
}
let loadController: AbortController | null = null;
let loadGeneration = 0;
let allIdentity = "",
  allCursor: string | null = null,
  allComplete = false,
  allCount = 0;
let deferredReload = false;
let deferredSorts: SortSpec | null = null;
const viewIdentity = () =>
  JSON.stringify([
    state.screen,
    state.poolId,
    state.profileId,
    state.filter,
    state.sorts,
    state.pageSize,
    state.cursor,
  ]);
const editing = () => !!(state.drafts.size || state.saving || state.grid?.editing);
function cancelLoad() {
  loadController?.abort();
  loadController = null;
  loadGeneration++;
  updateLoadControls();
}
function updateLoadControls() {
  const all = state.pageSize === "all";
  const live = document.getElementById("task-live-refresh") as HTMLInputElement | null;
  if (live) {
    live.disabled = all;
    live.checked = !all && state.live;
    live.title = all ? "All rows refresh manually." : "";
  }
  const progress = document.getElementById("all-load-progress");
  if (progress)
    progress.textContent = !all
      ? ""
      : allComplete
        ? `All ${state.rows.length.toLocaleString()} rows loaded · manual refresh`
        : `${state.rows.length.toLocaleString()} of ${allCount.toLocaleString()} loaded · ${loadController ? "loading" : "incomplete"}`;
  for (const b of main?.querySelectorAll<HTMLButtonElement>(".pagination button") ?? []) {
    if (b.textContent === "Cancel loading") b.hidden = !all || !loadController;
    if (b.textContent === "Retry loading") b.hidden = !all || allComplete || !!loadController;
    if (b.textContent === "← Previous" || b.textContent === "Next →") b.hidden = all;
  }
}
function renderSorts() {
  const host = document.getElementById("task-sorts");
  if (!host) return;
  host.replaceChildren(el("span", { class: "muted" }, "Sort priority:"));
  for (const [i, s] of state.sorts.entries()) {
    const label = state.fields.find((f) => f.key === s.field)?.label ?? s.field;
    host.append(
      button(`${i + 1}. ${label} ${s.direction === "asc" ? "↑" : "↓"} ×`, () =>
        changeSorts(state.sorts.filter((x) => x.field !== s.field)),
      ),
    );
  }
  host.append(button("Reset sorting", () => changeSorts(defaultSorts())));
  state.grid?.setSorts(state.sorts);
}
async function changeSorts(sorts: SortSpec) {
  if (editing()) {
    deferredSorts = sorts;
    toast("Sorting will apply after edits are saved or discarded.");
    return;
  }
  const local = state.pageSize === "all" && allComplete && allIdentity === viewIdentity();
  cancelLoad();
  state.sorts = sorts;
  state.cursor = null;
  state.back = [];
  if (local) {
    const generation = loadGeneration;
    allIdentity = viewIdentity();
    state.rows.sort(taskComparator(sorts, state.fields));
    await state.grid?.replaceRows(state.rows, state.fields);
    if (generation !== loadGeneration) return;
    renderSorts();
    updateLoadControls();
  } else await loadPage();
}
function flushDeferred() {
  if (editing()) return;
  if (deferredSorts) {
    const sorts = deferredSorts;
    deferredSorts = null;
    deferredReload = false;
    void changeSorts(sorts);
  } else if (deferredReload) {
    deferredReload = false;
    void loadPage();
  }
}
async function renderTaskRows(append: TaskRow[] | null = null) {
  const host = document.getElementById("task-grid");
  if (!host) return;
  if (state.grid) {
    if (append) await state.grid.appendRows(append, state.fields);
    else await state.grid.replaceRows(state.rows, state.fields);
  } else {
    state.grid = new TaskGrid(
      host,
      state.fields,
      state.rows,
      saveCell,
      (r) => taskForm(r),
      (count) => {
        selectedLabel.textContent = `${count} selected (loaded rows)`;
      },
      (key) => {
        if (["tags_text", "expires_at"].includes(key)) return;
        const field = state.fields.find((f) => f.key === key);
        if (field?.type === "json") {
          toast("JSON columns cannot be sorted. Map a scalar field instead.");
          return;
        }
        try {
          void changeSorts(promoteSort(deferredSorts ?? state.sorts, key)).catch(notifyError);
        } catch (e) {
          notifyError(e);
        }
      },
      pasteRectangle,
      state.sorts,
      flushDeferred,
    );
    await state.grid.ready;
  }
  renderSorts();
}
async function loadPage(resume = false) {
  cancelLoad();
  if (editing()) {
    deferredReload = true;
    toast("Refresh will resume after edits are saved or discarded.");
    return;
  }
  if (deferredSorts) {
    state.sorts = deferredSorts;
    deferredSorts = null;
    state.cursor = null;
    state.back = [];
  }
  deferredReload = false;
  const generation = loadGeneration,
    identity = viewIdentity(),
    all = state.pageSize === "all";
  const controller = new AbortController();
  loadController = controller;
  let cursor = all && resume && allIdentity === identity ? allCursor : all ? null : state.cursor;
  const continuing = all && resume && allIdentity === identity && state.rows.length > 0 && !!cursor;
  if (all) {
    if (!continuing) {
      allCursor = null;
      allComplete = false;
      allCount = 0;
    }
    allIdentity = identity;
  }
  let first = !continuing;
  let selected = state.grid?.selected().map((r) => r.task_uid) ?? [];
  let columns = state.grid?.columns();
  try {
    if (all && !continuing) {
      state.rows = [];
      if (state.grid) await state.grid.replaceRows([], state.fields);
      if (controller.signal.aborted || generation !== loadGeneration) return;
    }
    updateLoadControls();
    do {
      const query = new URLSearchParams({
        filter: state.filter,
        sorts: JSON.stringify(state.sorts),
        limit: String(all ? 250 : state.pageSize),
      });
      if (state.profileId) query.set("profile_id", state.profileId);
      if (cursor) query.set("cursor", cursor);
      const result = await api(
        `/pools/${state.poolId}/tasks?${query}`,
        undefined,
        "GET",
        controller.signal,
      );
      if (controller.signal.aborted || generation !== loadGeneration || identity !== viewIdentity())
        return;
      if (editing()) {
        deferredReload = true;
        return;
      }
      const sameFields = JSON.stringify(state.fields) === JSON.stringify(result.fields);
      if (!sameFields && state.grid) {
        columns = state.grid.columns();
        state.grid.destroy();
        state.grid = null;
      }
      const restoreColumns = !state.grid;
      state.fields = result.fields;
      if (first || !all) state.rows = result.rows;
      else {
        const seen = new Set(state.rows.map((r) => r.task_uid));
        result.rows = result.rows.filter((r: TaskRow) => !seen.has(r.task_uid));
        state.rows.push(...result.rows);
      }
      await renderTaskRows(!first && all ? result.rows : null);
      if (controller.signal.aborted || generation !== loadGeneration) return;
      if (restoreColumns && columns) state.grid?.applyColumns(columns);
      const loadedIds = new Set(state.rows.map((r) => r.task_uid));
      state.grid?.table.selectRow(selected.filter((id) => loadedIds.has(id)));
      // Restore each prior selection once; later pages must respect new deselections.
      selected = selected.filter((id) => !loadedIds.has(id));
      state.next = result.cursor;
      state.lastUpdated = new Date().toLocaleTimeString();
      status.textContent = `${result.total.toLocaleString()} tasks · updated ${state.lastUpdated}`;
      status.className = "badge";
      cursor = result.cursor;
      if (all) {
        allCount = result.total;
        allCursor = cursor;
        allComplete = cursor === null;
      }
      first = false;
      updateLoadControls();
    } while (all && cursor && !controller.signal.aborted);
  } catch (e) {
    if (controller.signal.aborted || generation !== loadGeneration) return;
    status.textContent = all ? "Load incomplete — retry loading" : "Refresh failed";
    status.className = "badge error";
    notifyError(e);
  } finally {
    if (generation === loadGeneration) {
      loadController = null;
      updateLoadControls();
    }
  }
}
function updateStatus() {
  if (!status) return;
  status.textContent = state.saving
    ? `Saving ${state.saving}…`
    : state.drafts.size
      ? `${state.drafts.size} unsaved edit${state.drafts.size === 1 ? "" : "s"}`
      : `Saved · ${state.lastUpdated}`;
  status.className = state.drafts.size && !state.saving ? "badge error" : "badge";
}
function patchFor(key: string, value: unknown) {
  if (key.startsWith("input:"))
    return {
      data: {
        [key.slice(6)]: inputValue(
          value,
          state.fields.find((f) => f.key === key.slice(6))!,
        ),
      },
    };
  if (key === "tags_text")
    return {
      tags: String(value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  return { [key]: value };
}
const rowQueues = new Map<string, Promise<void>>();
function saveCell(row: TaskRow, key: string, value: unknown) {
  const draft: Draft = { row, key, value },
    id = `${row.task_uid}:${key}`;
  draft.staged = Array.from(state.drafts.values()).some(
    (d) => d.row.task_uid === row.task_uid && d.staged,
  );
  state.drafts.set(id, draft);
  updateStatus();
  if (draft.staged) return;
  const queue = (rowQueues.get(row.task_uid) ?? Promise.resolve()).then(() =>
    persistDraft(id, draft),
  );
  rowQueues.set(row.task_uid, queue);
}
async function pasteRectangle(text: string, rows: TaskRow[], columns: string[]) {
  const parsed = await parseTable(text);
  if (parsed.errors.length) throw new Error(parsed.errors[0].message);
  if (parsed.rows.length > rows.length)
    throw new Error("The paste extends beyond the loaded rows. Use Import / paste to add tasks.");
  const staged: { row: TaskRow; key: string; value: unknown }[] = [];
  for (let ix = 0; ix < parsed.rows.length; ix++)
    for (let col = 0; col < parsed.rows[ix].length; col++) {
      const key = columns[col];
      if (
        !key ||
        (!key.startsWith("input:") && !["enabled", "admin_note", "tags_text"].includes(key))
      )
        throw new Error(
          "The paste includes a read-only column. Start within editable input columns.",
        );
      const raw = parsed.rows[ix][col],
        value =
          key === "enabled"
            ? inputValue(raw, { type: "boolean", nullable: false, label: "Enabled" })
            : key.startsWith("input:")
              ? inputValue(
                  raw,
                  state.fields.find((f) => f.key === key.slice(6))!,
                )
              : raw;
      staged.push({ row: rows[ix], key, value });
    }
  for (const d of staged) {
    state.drafts.set(`${d.row.task_uid}:${d.key}`, { ...d, staged: true });
    const row = state.grid!.table.getRow(d.row.task_uid);
    if (row) {
      row.getCell(d.key).getElement().classList.add("cell-draft");
      await row.update({ [d.key]: d.value });
    }
  }
  updateStatus();
  toast(`${staged.length} pasted cells staged. Review them, then choose Save drafts.`);
}
async function saveStagedDrafts() {
  const drafts = Array.from(state.drafts.entries()).filter(([, d]) => d.staged);
  if (!drafts.length) {
    toast("No pasted drafts to save.");
    return;
  }
  const grouped = new Map<string, any>();
  for (const [, d] of drafts) {
    const item = grouped.get(d.row.task_uid) ?? {
      task_uid: d.row.task_uid,
      expected_edit_revision: d.row.edit_revision,
      patch: {},
    };
    const patch = patchFor(d.key, d.value);
    item.patch = {
      ...item.patch,
      ...patch,
      ...(patch.data ? { data: { ...item.patch.data, ...patch.data } } : {}),
    };
    grouped.set(d.row.task_uid, item);
  }
  const items = Array.from(grouped.values()),
    d = dialog("Review pasted edits"),
    message = el("p"),
    ops: string[] = [];
  for (let start = 0; start < items.length; start += 50) {
    const result = await api("/tasks/bulk/patches/preview", {
      ...operation(),
      pool_id: state.poolId,
      rows: items.slice(start, start + 50),
    });
    ops.push(result.operation_id);
  }
  d.content.append(
    el(
      "p",
      {},
      `${items.length} rows are frozen with their expected revisions. Concurrent changes will be reported as conflicts.`,
    ),
    el("pre", {}, stringify(items)),
    message,
    button(
      "Save reviewed drafts",
      async () => {
        let rejected = 0;
        for (const id of ops) {
          const result = await api(`/operations/${id}/apply`, { ...operation(), limit: 50 });
          const op = await api(`/operations/${id}`);
          rejected += op.counts.find((x: any) => x.status === "rejected")?.count ?? 0;
          for (const item of result.items)
            if (item.status === "applied")
              for (const [key, draft] of drafts)
                if (draft.row.task_uid === item.task_uid && state.drafts.get(key) === draft)
                  state.drafts.delete(key);
        }
        message.textContent = `Saved matching revisions. ${rejected} conflicts retained as drafts.`;
        if (!rejected) d.dialog.close();
        else
          for (const id of ops)
            d.content.append(button("Download conflicts", () => downloadOperationErrors(id)));
        await loadPage();
        updateStatus();
        flushDeferred();
      },
      "primary",
    ),
    button("Cancel pending operations", async () => {
      for (const id of ops) await api(`/operations/${id}/cancel`, operation());
      d.dialog.close();
    }),
  );
}
async function persistDraft(id: string, draft: Draft) {
  state.saving++;
  updateStatus();
  try {
    const current = state.rows.find((r) => r.task_uid === draft.row.task_uid) ?? draft.row;
    draft.body ??= {
      ...operation(),
      expected_edit_revision: current.edit_revision,
      expected_input_revision: current.input_revision,
      patch: patchFor(draft.key, draft.value),
    };
    const row = await api<TaskRow>(`/tasks/${current.task_uid}`, draft.body, "PATCH");
    const index = state.rows.findIndex((r) => r.task_uid === row.task_uid);
    if (index >= 0) state.rows[index] = row;
    if (state.drafts.get(id) === draft) {
      state.drafts.delete(id);
      await state.grid?.update(row, state.fields);
    }
    state.lastUpdated = new Date().toLocaleTimeString();
  } catch (error) {
    draft.error = error;
    const d = dialog("Edit not saved", true);
    d.content.append(errorBox(error));
    const server = (error as ApiError).details?.current;
    if (server)
      d.content.append(
        el(
          "div",
          { class: "conflict-grid" },
          el(
            "div",
            {},
            el("strong", {}, "Current server value"),
            el("pre", {}, stringify(server.data)),
          ),
          el(
            "div",
            {},
            el("strong", {}, "Your attempted value"),
            el("pre", {}, stringify(draft.value)),
          ),
        ),
      );
    d.content.append(
      el(
        "div",
        { class: "form-actions" },
        button("Discard / reload", async () => {
          state.drafts.delete(id);
          d.dialog.close();
          await loadPage();
        }),
        button(
          server ? "Retry against this revision" : "Retry same operation",
          async () => {
            if (server) {
              draft.row = server;
              draft.body = {
                ...operation(),
                expected_edit_revision: server.edit_revision,
                expected_input_revision: server.input_revision,
                patch: patchFor(draft.key, draft.value),
              };
            }
            d.dialog.close();
            await persistDraft(id, draft);
          },
          "primary",
        ),
      ),
    );
    if (["TASK_LEASED", "TASK_COMPLETED"].includes((error as ApiError).code))
      d.content.append(
        button(
          (error as ApiError).code === "TASK_LEASED"
            ? "Preview Revoke and edit"
            : "Preview Reset and edit",
          async () => {
            d.dialog.close();
            const applied = await runBulk(
              {
                kind: (error as ApiError).code === "TASK_LEASED" ? "revoke_edit" : "reset_edit",
                patch: patchFor(draft.key, draft.value),
                revoke: true,
                scope: "all",
                mode: "full",
              },
              [draft.row.task_uid],
            );
            if (applied) state.drafts.delete(id);
            await loadPage();
          },
          "danger",
        ),
      );
  } finally {
    state.saving--;
    updateStatus();
    flushDeferred();
  }
}
async function taskForm(row?: TaskRow) {
  let formFields = state.fields;
  if (!row) formFields = (await api(`/pools/${state.poolId}/fields`)).fields;
  if (row) {
    const detail = await api(`/tasks/${row.task_uid}`);
    row = detail.task;
    formFields = detail.fields;
  }

  const d = dialog(row ? `Task ${row.task_id}` : "Add task"),
    form = el("form"),
    grid = el("div", { class: "form-grid" }),
    id = el("input", {
      value: row?.task_id ?? "",
      placeholder: "Generated when blank",
    }),
    tags = el("input", { value: row?.tags.join(", ") ?? "" }),
    note = el("textarea", { value: row?.admin_note ?? "" }),
    enabled = el("input", { type: "checkbox", checked: row?.enabled ?? true });
  const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
  const presence = new Map<string, HTMLSelectElement>();
  grid.append(labeled("Task ID", id), labeled("Tags (comma-separated)", tags));
  for (const f of formFields.filter((f) => f.kind === "input" && f.active)) {
    const value = row?.data[f.key] ?? f.default;
    const input =
      f.type === "json"
        ? el("textarea", { value: value === undefined ? "" : stringify(value) })
        : f.type === "boolean"
          ? select(
              [
                { value: "", label: "Blank" },
                { value: "true", label: "True" },
                { value: "false", label: "False" },
              ],
              value === undefined || value === null ? "" : String(value),
            )
          : el("input", {
              value: value === undefined || value === null ? "" : String(value),
            });
    input.setAttribute("aria-label", f.label);
    controls.set(f.key, input);
    const mode = select(
      [
        { value: "value", label: "Set value" },
        ...(!f.required ? [{ value: "missing", label: "Remove field (missing)" }] : []),
        ...(f.nullable ? [{ value: "null", label: "Explicit null" }] : []),
      ],
      row && Object.hasOwn(row.data, f.key)
        ? row.data[f.key] === null
          ? "null"
          : "value"
        : !f.required && f.default === undefined
          ? "missing"
          : "value",
    );
    presence.set(f.key, mode);
    mode.onchange = () => {
      input.disabled = mode.value !== "value" || row?.migration_status === "migrating";
    };
    mode.onchange(new Event("change"));
    grid.append(
      el(
        "div",
        {},
        labeled(`${f.label}${f.required ? " *" : ""}`, input),
        labeled(`${f.label} presence`, mode),
      ),
    );
  }
  const maxMode = select(
      [
        { value: "inherit", label: "Inherit profile policy" },
        { value: "unlimited", label: "Unlimited attempts" },
        { value: "value", label: "Set maximum attempts" },
      ],
      row?.max_attempts === "inherit" || row?.max_attempts === undefined
        ? "inherit"
        : row.max_attempts === null
          ? "unlimited"
          : "value",
    ),
    maxValue = el("input", {
      type: "number",
      min: 0,
      step: 1,
      value: typeof row?.max_attempts === "number" ? row.max_attempts : 10,
    });
  if (row)
    grid.append(
      labeled("Attempt limit override", maxMode),
      labeled("Maximum (zero prevents new attempts)", maxValue),
    );
  grid.append(labeled("Enabled", enabled), labeled("Admin note", note));
  form.append(grid);
  const errors = el("div");
  form.append(
    errors,
    el(
      "div",
      { class: "form-actions" },
      button("Cancel", () => d.dialog.close()),
      el("button", { type: "submit", class: "primary" }, row ? "Save changes" : "Add task"),
    ),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    errors.replaceChildren();
    let attemptedPatch: any;
    try {
      const data: Record<string, unknown> = {},
        unset: string[] = [];
      for (const f of formFields.filter((f) => f.kind === "input" && f.active)) {
        const mode = presence.get(f.key)!.value;
        if (mode === "missing") {
          if (row && Object.hasOwn(row.data, f.key)) unset.push(f.key);
          continue;
        }
        data[f.key] = mode === "null" ? null : inputValue(controls.get(f.key)!.value, f);
      }
      if (row) {
        const changed = Object.fromEntries(
          Object.entries(data).filter(
            ([k, v]) => JSON.stringify(v) !== JSON.stringify(row.data[k]),
          ),
        );
        const patch: any = {};
        const maximum =
          maxMode.value === "inherit"
            ? "inherit"
            : maxMode.value === "unlimited"
              ? null
              : Number(maxValue.value);
        if (maximum !== row.max_attempts) patch.max_attempts = maximum;
        if (Object.keys(changed).length) patch.data = changed;
        if (unset.length) patch.unset = unset;
        if (tags.value !== row.tags.join(", ")) patch.tags = tags.value.split(",");
        if (note.value !== row.admin_note) patch.admin_note = note.value;
        if (enabled.checked !== row.enabled) patch.enabled = enabled.checked;
        if (id.value !== row.task_id) patch.task_id = id.value;
        attemptedPatch = patch;
        await api(
          `/tasks/${row.task_uid}`,
          {
            ...operation(),
            expected_edit_revision: row.edit_revision,
            expected_input_revision: row.input_revision,
            patch,
          },
          "PATCH",
        );
      } else
        await api(`/pools/${state.poolId}/tasks`, {
          ...operation(),
          ...(id.value ? { task_id: id.value } : {}),
          data,
          tags: tags.value.split(",").filter(Boolean),
          enabled: enabled.checked,
          admin_note: note.value,
        });
      d.dialog.close();
      await loadPage();
    } catch (error) {
      errors.append(errorBox(error));
      if (row && attemptedPatch && error instanceof ApiError && error.details?.current) {
        const current = error.details.current;
        errors.append(
          el(
            "details",
            {},
            el("summary", {}, "Current server values"),
            el("pre", {}, stringify(current)),
          ),
        );
        if (["TASK_LEASED", "TASK_COMPLETED"].includes(error.code))
          errors.append(
            button(
              error.code === "TASK_LEASED" ? "Review revoke and edit" : "Review reset and edit",
              async () => {
                const applied = await runBulk(
                  {
                    kind: error.code === "TASK_LEASED" ? "revoke_edit" : "reset_edit",
                    patch: attemptedPatch,
                    scope: "all",
                    mode: "full",
                    revoke: true,
                  },
                  [row!.task_uid],
                );
                if (applied) {
                  d.dialog.close();
                  await loadPage();
                }
              },
              "danger",
            ),
          );
        else
          errors.append(
            button(
              "Apply draft using the current revision",
              async () => {
                await api(
                  `/tasks/${row!.task_uid}`,
                  {
                    ...operation(),
                    expected_edit_revision: current.edit_revision,
                    expected_input_revision: current.input_revision,
                    patch: attemptedPatch,
                  },
                  "PATCH",
                );
                d.dialog.close();
                await loadPage();
              },
              "primary",
            ),
          );
      }
    }
  };
  if (row?.migration_status === "migrating") {
    for (const control of [...controls.values(), ...presence.values()]) control.disabled = true;
    id.disabled = true;
    tags.disabled = true;
    d.content.append(
      el(
        "p",
        { class: "input-note" },
        "Schema migration is in progress. Inputs are read-only until all rows validate.",
      ),
    );
  }
  d.content.append(form);
  if (row) {
    d.content.append(
      el("h3", { style: "margin-top:24px" }, "Current result"),
      el("pre", {}, stringify(row.result)),
      button("Load attempt history", async () => {
        const history = await api(`/tasks/${row.task_uid}/attempts`);
        const h = dialog("Attempt history");
        if (history.imported_history)
          h.content.append(
            el("h3", {}, "Imported history (original worker and times unknown)"),
            el("pre", {}, stringify(history.imported_history)),
          );
        for (const a of history.attempts)
          h.content.append(
            el(
              "details",
              {},
              el(
                "summary",
                {},
                `Attempt ${a.attempt_sequence} · ${a.outcome ?? (a.revoked_at ? "revoked" : "unresolved")} · ${a.worker_id}`,
              ),
              el("pre", {}, stringify(a)),
            ),
          );
        if (history.cursor)
          h.content.append(
            button("More attempts", () => loadHistory(h.content, row.task_uid, history.cursor)),
          );
      }),
    );
  }
}
async function loadHistory(container: HTMLElement, uid: string, cursor: string) {
  const result = await api(`/tasks/${uid}/attempts?cursor=${encodeURIComponent(cursor)}`);
  for (const a of result.attempts)
    container.append(
      el(
        "details",
        {},
        el("summary", {}, `Attempt ${a.attempt_sequence} · ${a.outcome ?? "unresolved"}`),
        el("pre", {}, stringify(a)),
      ),
    );
  if (result.cursor)
    container.append(button("More attempts", () => loadHistory(container, uid, result.cursor)));
}
function bulkDialog() {
  const selected = state.grid?.selected() ?? [],
    d = dialog("Bulk actions", true),
    scope = select([
      { value: "selected", label: `Selected loaded rows (${selected.length})` },
      { value: "all", label: "All rows matching the current filter" },
    ]),
    kind = select(
      [
        "enable",
        "disable",
        "set_tags",
        "edit",
        "duplicate",
        "delete",
        "restore",
        "revoke",
        "reset",
      ].map((v) => ({ value: v, label: v.replaceAll("_", " ") })),
    ),
    mode = select([
      { value: "soft", label: "Soft reset" },
      { value: "full", label: "Full reset" },
    ]),
    resetScope = select([
      { value: "all", label: "All profiles (global)" },
      { value: "profile", label: "Selected profile only" },
    ]),
    revoke = el("input", { type: "checkbox" }),
    tags = el("input", { placeholder: "ready, gpu" }),
    field = select(
      state.fields.filter((f) => f.kind === "input").map((f) => ({ value: f.key, label: f.label })),
    ),
    value = el("input"),
    reason = el("input", { placeholder: "Reason for this operation" });
  d.content.append(
    el(
      "div",
      { class: "form-grid" },
      labeled("Selection", scope),
      labeled("Action", kind),
      labeled("Tags", tags),
      labeled("Input field", field),
      labeled("Input value", value),
      labeled("Reset mode", mode),
      labeled("Reset scope", resetScope),
      labeled("Explicitly revoke outstanding lease", revoke),
      labeled("Reason", reason),
    ),
    el(
      "p",
      { class: "input-note" },
      "Preview freezes the IDs and revisions. Concurrent changes are reported as conflicts. Profile resets preserve global success; a soft reset does not clear exhausted attempt caps.",
    ),
    button(
      "Preview operation",
      async () => {
        const patch =
          kind.value === "set_tags"
            ? { tags: tags.value.split(",") }
            : kind.value === "edit"
              ? {
                  data: {
                    [field.value]: inputValue(
                      value.value,
                      state.fields.find((f) => f.key === field.value)!,
                    ),
                  },
                }
              : undefined;
        d.dialog.close();
        await runBulk(
          {
            kind: kind.value,
            mode: mode.value,
            scope: resetScope.value,
            revoke: revoke.checked,
            reason: reason.value,
            ...(patch ? { patch } : {}),
          },
          scope.value === "selected" ? selected.map((r) => r.task_uid) : undefined,
        );
      },
      "primary",
    ),
  );
}
async function runBulk(action: any, ids?: string[]) {
  if (ids && !ids.length) throw new Error("Select at least one row.");
  const preview = await api("/tasks/bulk/preview", {
    ...operation(),
    pool_id: state.poolId,
    ...(state.profileId ? { profile_id: state.profileId } : {}),
    selection: { ...(ids ? { ids } : {}), filter: state.filter },
    action,
  });
  const op = await api(`/operations/${preview.operation_id}`),
    d = dialog("Review operation", true);
  d.content.append(
    el(
      "p",
      {},
      `${op.total} frozen tasks will be considered for “${action.kind.replaceAll("_", " ")}”.`,
    ),
    el(
      "pre",
      {},
      op.items
        .map(
          (i: any) =>
            `${i.task_id ?? i.task_uid} · revision ${i.expected_edit_revision} · generation ${i.expected_generation}${i.worker_id ? ` · worker ${i.worker_id} · issuing profile ${i.issuing_profile_id} · expires ${new Date(i.expires_at).toISOString()}` : ""}`,
        )
        .join("\n"),
    ),
    el(
      "p",
      { class: "input-note" },
      "Completed chunks stay committed if you cancel. A replacement lease or changed task will be skipped.",
    ),
  );
  return new Promise<boolean>((resolve) => {
    let stopped = false;
    const progress = el("progress", {
        class: "progress",
        max: op.total || 1,
        value: 0,
      }),
      report = el("p");
    d.content.append(
      progress,
      report,
      el(
        "div",
        { class: "form-actions" },
        button("Cancel", async () => {
          stopped = true;
          await api(`/operations/${op.id}/cancel`, operation());
          d.dialog.close();
          resolve(false);
        }),
        button(
          "Apply reviewed action",
          async () => {
            let applied = 0,
              rejected = 0;
            while (!stopped) {
              const result = await api(`/operations/${op.id}/apply`, {
                ...operation(),
                limit: 50,
              });
              if (!result.items.length) break;
              applied += result.items.filter((i: any) => i.status === "applied").length;
              rejected += result.items.filter((i: any) => i.status === "rejected").length;
              progress.value = applied + rejected;
              report.textContent = `${applied} applied, ${rejected} conflicting or rejected`;
              if (applied + rejected >= op.total) break;
            }
            toast(`${applied} applied; ${rejected} rejected.`);
            resolve(rejected === 0 && applied > 0);
            if (rejected)
              d.content.append(
                button("Download rejected rows", () => downloadOperationErrors(op.id)),
              );
            await loadPage();
          },
          "danger",
        ),
      ),
    );
    d.dialog.addEventListener("cancel", () => resolve(false));
    d.dialog.addEventListener("close", () => resolve(false));
  });
}
async function downloadOperationErrors(id: string) {
  const parts: string[] = [];
  let offset = 0;
  while (true) {
    const result = await api(`/operations/${id}?offset=${offset}`);
    for (const item of result.items)
      if (item.status === "rejected") parts.push(JSON.stringify(item) + "\n");
    if (result.items.length < 100) break;
    offset += 100;
  }
  download("operation-errors.ndjson", parts, "application/x-ndjson");
}
function columnDialog() {
  const d = dialog("Visible columns", true);
  for (const column of state.grid?.table.getColumns() ?? []) {
    if (!column.getField()) continue;
    const input = el("input", {
      type: "checkbox",
      checked: column.isVisible(),
      onchange: () => (input.checked ? column.show() : column.hide()),
    });
    d.content.append(labeled(column.getDefinition().title ?? column.getField(), input));
  }
  d.content.append(
    el(
      "p",
      { class: "input-note" },
      "Drag column headers to reorder. Save a view to keep these choices across browsers.",
    ),
  );
}
function viewDialog() {
  const d = dialog("Saved views", true),
    name = el("input", { placeholder: "View name" }),
    shared = el("input", { type: "checkbox" });
  d.content.append(
    labeled("Name", name),
    labeled("Shared with administrators", shared),
    button(
      "Save current view",
      async () => {
        await api("/views", {
          ...operation(),
          pool_id: state.poolId,
          profile_id: state.profileId || null,
          name: name.value,
          shared: shared.checked,
          presentation: {
            filter: state.filter,
            sorts: state.sorts,
            page_size: state.pageSize,
            profile_id: state.profileId || null,
            columns: state.grid?.columns() ?? [],
          },
        });
        await refreshConfig();
        d.dialog.close();
        toast("View saved.");
      },
      "primary",
    ),
  );
  for (const view of state.views.filter((v) => v.pool_id === state.poolId)) {
    d.content.append(
      button(`Delete view ${view.name}`, async () => {
        await api(
          `/views/${view.id}`,
          { ...operation(), expected_revision: view.revision },
          "DELETE",
        );
        await refreshConfig();
        d.dialog.close();
        viewDialog();
      }),
    );
    d.content.append(
      button(`${view.name}${view.shared ? " · shared" : ""}`, async () => {
        const p = view.presentation;
        Object.assign(state, {
          filter: p.filter,
          sorts: sortKeys(sortChoice(p), state.fields),
          pageSize: p.page_size,
          profileId: p.profile_id ?? "",
          cursor: null,
          back: [],
        });
        d.dialog.close();
        await navigate("tasks", true);
        state.grid?.applyColumns(p.columns);
      }),
    );
  }
}
function filterBuilder(target: HTMLInputElement) {
  const d = dialog("Build a filter", true),
    field = select([
      ...state.fields
        .filter((f) => f.type !== "json")
        .map((f) => ({ value: f.key, label: f.label })),
      ...["status", "attempts", "enabled"].map((v) => ({ value: v, label: v })),
    ]),
    operator = select(
      ["=", "!=", "<", "<=", ">", ">=", "CONTAINS", "STARTS_WITH", "IS BLANK", "IS NOT BLANK"].map(
        (v) => ({ value: v, label: v }),
      ),
    ),
    value = el("input"),
    join = select([
      { value: "AND", label: "Match all (AND)" },
      { value: "OR", label: "Match either (OR)" },
    ]);
  d.content.append(
    labeled("Field", field),
    labeled("Operator", operator),
    labeled("Value", value),
    labeled("Combine with existing filter", join),
    button(
      "Add condition",
      () => {
        const f = state.fields.find((f) => f.key === field.value),
          typed =
            f?.type ??
            (field.value === "attempts"
              ? "integer"
              : field.value === "enabled"
                ? "boolean"
                : "string"),
          literal =
            typed === "integer" || typed === "number" || typed === "boolean"
              ? value.value
              : typed === "datetime"
                ? `datetime(${JSON.stringify(value.value)})`
                : JSON.stringify(value.value),
          condition = `\`${field.value}\` ${operator.value}${operator.value.startsWith("IS ") ? "" : ` ${literal}`}`;
        target.value = target.value ? `(${target.value}) ${join.value} (${condition})` : condition;
        d.dialog.close();
      },
      "primary",
    ),
  );
}
function addDraftRows() {
  const d = dialog("Add draft rows"),
    count = el("input", { type: "number", min: 1, max: 100, value: 5 }),
    holder = el("div", { class: "table-scroll" });
  const fields = state.fields.filter((f) => f.kind === "input" && f.active);
  let cells: HTMLInputElement[][] = [];
  const render = () => {
    cells = [];
    const table = el(
        "table",
        { class: "data-table" },
        el(
          "thead",
          {},
          el("tr", {}, ...["Task ID", ...fields.map((f) => f.label)].map((t) => el("th", {}, t))),
        ),
      ),
      body = el("tbody");
    for (let i = 0; i < Math.min(100, Math.max(1, Number(count.value))); i++) {
      const row = el("tr");
      const controls = [
        el("input", { placeholder: "Generated when blank", "aria-label": `Row ${i + 1} Task ID` }),
        ...fields.map((f) =>
          el("input", {
            "aria-label": `Row ${i + 1} ${f.label}`,
            value:
              f.default === undefined
                ? ""
                : typeof f.default === "object"
                  ? JSON.stringify(f.default)
                  : String(f.default),
          }),
        ),
      ];
      cells.push(controls);
      row.append(...controls.map((c) => el("td", {}, c)));
      body.append(row);
    }
    table.append(body);
    holder.replaceChildren(table);
  };
  count.onchange = render;
  render();
  d.content.append(
    labeled("Blank rows", count),
    el(
      "p",
      {},
      "Enter inputs below. Nothing is committed until you review the import and select Save.",
    ),
    holder,
    button(
      "Preview these rows",
      async () => {
        const { default: Papa } = await import("papaparse");
        const text = Papa.unparse(
          [["task_id", ...fields.map((f) => f.key)], ...cells.map((r) => r.map((c) => c.value))],
          { delimiter: "\t" },
        );
        d.dialog.close();
        importDialog(state.poolId, state.fields, () => loadPage(), text);
      },
      "primary",
    ),
  );
}
async function activity() {
  main.append(
    el("h1", {}, "Activity"),
    el(
      "p",
      { class: "muted" },
      "Inspect active leases, resume reviewed operations, and review the audit trail.",
    ),
  );
  const pool = select([
      { value: "", label: "All pools" },
      ...state.pools.map((p) => ({ value: p.id, label: p.name })),
    ]),
    worker = el("input", { placeholder: "Worker ID" }),
    family = select([
      { value: "", label: "All families" },
      ...state.families.map((f) => ({ value: f.id, label: f.name })),
    ]);
  const leasePanel = el("section", { class: "panel" });
  let cursor: string | null = null;
  const loadLeases = async (append = false) => {
    const params = new URLSearchParams();
    if (pool.value) params.set("pool_id", pool.value);
    if (family.value) params.set("family_id", family.value);
    if (worker.value) params.set("worker_id", worker.value);
    if (append && cursor) params.set("cursor", cursor);
    const r = await api("/leases?" + params);
    if (!append) leasePanel.replaceChildren(el("h2", {}, "Active leases"));
    for (const row of r.rows)
      leasePanel.append(
        el(
          "details",
          {},
          el("summary", {}, `${row.task_id} ? ${row.worker_id}`),
          el("pre", {}, stringify(row)),
        ),
      );
    cursor = r.cursor;
    if (!r.rows.length) leasePanel.append(el("p", {}, "No active leases."));
  };
  main.append(
    el(
      "div",
      { class: "toolbar" },
      labeled("Pool", pool),
      labeled("Family", family),
      labeled("Worker", worker),
      button("Filter leases", () => loadLeases()),
      button("More leases", () => (cursor ? loadLeases(true) : undefined)),
    ),
    leasePanel,
  );
  await loadLeases();
  const operations = await api("/operations");
  const panel = el("section", { class: "panel" }, el("h2", {}, "Operations"));
  for (const op of operations.rows)
    panel.append(
      el(
        "div",
        { class: "activity-row" },
        button(`${op.kind} ? ${op.status} ? ${op.processed}/${op.total}`, () =>
          reviewOperation(op.id),
        ),
      ),
    );
  main.append(panel);
  for (const resource of ["warnings", "audit"]) {
    const section = el(
        "section",
        { class: "panel" },
        el("h2", {}, resource === "warnings" ? "Warnings" : "Audit"),
      ),
      rows = el("div");
    let offset = 0;
    const load = async () => {
      const result = await api(`/${resource}?offset=${offset}`);
      offset += result.rows.length;
      for (const row of result.rows) {
        const item = el(
          "details",
          {},
          el("summary", {}, row.message ?? `${row.entity_type} ? ${row.actor}`),
          el("pre", {}, stringify(row)),
        );
        if (resource === "warnings" && !row.resolved)
          item.append(
            button("Resolve warning", async () => {
              await api(`/warnings/${row.id}/resolve`, operation());
              item.append(el("p", {}, "Resolved."));
            }),
          );
        rows.append(item);
      }
      if (!offset) rows.append(el("p", {}, "No activity to show."));
    };
    section.append(rows, button("Load more", load));
    main.append(section);
    await load();
  }
}
async function reviewOperation(id: string) {
  const d = dialog("Review saved operation"),
    info = el("div"),
    progress = el("p");
  let op: any;
  const reload = async () => {
    op = await api(`/operations/${id}`);
    info.replaceChildren(
      el("p", {}, `${op.kind} ? ${op.status} ? ${op.processed}/${op.total}`),
      el("pre", {}, stringify(op.action)),
      el("pre", {}, stringify(op.items)),
    );
  };
  await reload();
  d.content.append(
    info,
    progress,
    button("Download row errors", () => downloadOperationErrors(id)),
    button("Refresh expired preview", async () => {
      await api(`/operations/${id}/refresh`, operation());
      await reload();
    }),
  );
  if (["bulk", "import"].includes(op.kind) && !["complete", "cancelled"].includes(op.status))
    d.content.append(
      button(
        "Apply reviewed rows / resume",
        async () => {
          let done = false;
          while (!done) {
            const result = await api(`/operations/${id}/apply`, { ...operation(), limit: 50 });
            if (!result.items.length) break;
            await reload();
            progress.textContent = `${op.processed}/${op.total} processed`;
            done = ["complete", "cancelled"].includes(op.status);
          }
          await reload();
        },
        "primary",
      ),
      button(
        "Cancel remaining rows",
        async () => {
          await api(`/operations/${id}/cancel`, operation());
          await reload();
        },
        "danger",
      ),
    );
  if (op.kind === "schema")
    d.content.append(
      el(
        "p",
        {},
        "Open the pool?s Columns editor to resume conversion and correct rejected values.",
      ),
    );
  if (op.kind === "portable")
    d.content.append(
      el("p", {}, "Re-select the same portable file in Settings to resume its verified chunks."),
    );
}
for (const event of ["pointerdown", "keydown"])
  document.addEventListener(
    event,
    () => {
      state.lastActivity = Date.now();
    },
    { passive: true },
  );
window.addEventListener("beforeunload", (event) => {
  if (state.drafts.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});
setInterval(() => {
  if (
    state.live &&
    !loadController &&
    state.pageSize !== "all" &&
    state.screen === "tasks" &&
    !document.hidden &&
    Date.now() - state.lastActivity < 900000 &&
    !document.querySelector("dialog[open]") &&
    !state.drafts.size &&
    !state.grid?.editing &&
    state.rows.some((r) => ["pending", "leased"].includes(r.status))
  )
    void loadPage();
}, 10000);
void start();
