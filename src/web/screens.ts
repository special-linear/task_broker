import { api, apiRows, operation } from "./api";
import { button, dialog, el, errorBox, labeled, select, stringify, toast } from "./dom";
import { DEFAULTS, type Field } from "../shared/core";
import { inputValue } from "./grid";
import { portableImport } from "./transfer";
import {
  archiveReason,
  familyFor,
  profileRoute,
  showArchived,
  setShowArchived,
  visibleConfiguration,
  type ConfigurationState,
} from "./configuration-view";
const types = ["string", "integer", "number", "boolean", "datetime", "json"];
function fieldsEditor(initial: Partial<Field>[] = []) {
  const host = el("div", { class: "fields-list" }),
    rows: {
      node: HTMLElement;
      key: HTMLInputElement;
      label: HTMLInputElement;
      type: HTMLSelectElement;
      kind: HTMLSelectElement;
      nullable: HTMLInputElement;
      required: HTMLInputElement;
      default: HTMLInputElement;
      pointer: HTMLInputElement;
      id?: string;
    }[] = [];
  const add = (f: Partial<Field> = {}) => {
    const key = el("input", {
        value: f.key ?? "",
        placeholder: "machine_key",
        "aria-label": "Field key",
      }),
      label = el("input", {
        value: f.label ?? "",
        placeholder: "Display label",
        "aria-label": "Field label",
      }),
      type = select(
        types.map((v) => ({ value: v, label: v })),
        f.type ?? "string",
      ),
      kind = select(
        [
          { value: "input", label: "Input" },
          { value: "result", label: "Result" },
        ],
        f.kind ?? "input",
      ),
      nullable = el("input", { type: "checkbox", checked: f.nullable ?? true }),
      required = el("input", {
        type: "checkbox",
        checked: f.required ?? false,
      }),
      defaultInput = el("input", {
        value:
          f.default === undefined
            ? ""
            : typeof f.default === "string"
              ? f.default
              : JSON.stringify(f.default),
        placeholder: "Optional default",
      }),
      pointer = el("input", {
        value: f.pointer ?? "",
        placeholder: "/metrics/value",
      }),
      mapping = el(
        "div",
        {},
        labeled("Result JSON Pointer", pointer),
        el(
          "p",
          { class: "input-note" },
          'For {"diameter": 4}, use /diameter. Leave blank only when the worker returns the value directly.',
        ),
      ),
      node = el("div", { class: "panel", style: "padding:12px;margin:0" });
    type.setAttribute("aria-label", "Field type");
    kind.setAttribute("aria-label", "Field kind");
    // Existing mappings (including the blank root pointer) stay explicit.
    let automaticPointer = f.pointer === undefined;
    const updateMapping = () => {
      mapping.hidden = kind.value !== "result";
      if (automaticPointer)
        pointer.value = key.value
          ? `/${key.value.replaceAll("~", "~0").replaceAll("/", "~1")}`
          : "";
    };
    key.addEventListener("input", updateMapping);
    kind.addEventListener("change", updateMapping);
    pointer.addEventListener("input", () => {
      automaticPointer = false;
    });
    updateMapping();
    const row = {
      node,
      key,
      label,
      type,
      kind,
      nullable,
      required,
      default: defaultInput,
      pointer,
      id: f.id,
    };
    rows.push(row);
    node.append(
      el(
        "div",
        { class: "field-row" },
        key,
        label,
        type,
        kind,
        button("×", () => {
          rows.splice(rows.indexOf(row), 1);
          node.remove();
        }),
      ),
      mapping,
      el(
        "details",
        {},
        el("summary", {}, "Field options"),
        el(
          "div",
          { class: "form-grid" },
          labeled("Required", required),
          labeled("Nullable", nullable),
          labeled("Default at creation", defaultInput),
        ),
        button("Move up", () => {
          const ix = rows.indexOf(row);
          if (ix > 0) {
            host.insertBefore(node, rows[ix - 1].node);
            rows.splice(ix, 1);
            rows.splice(ix - 1, 0, row);
          }
        }),
      ),
    );
    host.append(node);
  };
  for (const f of initial) add(f);
  const read = () =>
    rows.map((r, i) => ({
      ...(r.id ? { id: r.id } : {}),
      key: r.key.value,
      label: r.label.value || r.key.value,
      type: r.type.value,
      kind: r.kind.value,
      nullable: r.nullable.checked,
      required: r.required.checked,
      ...(r.default.value !== ""
        ? {
            default: r.type.value === "string" ? r.default.value : JSON.parse(r.default.value),
          }
        : {}),
      ...(r.kind.value === "result" ? { pointer: r.pointer.value } : {}),
      position: i,
      active: true,
    }));
  return { host, read, add: () => add() };
}
export function createPoolDialog(families: any[], done: (id: string) => Promise<void>) {
  families = families.filter((f) => !f.archived_at);
  const d = dialog("Create a pool"),
    form = el("form"),
    name = el("input", { required: true, placeholder: "Diameter experiments" }),
    description = el("textarea", {
      placeholder: "What are you investigating?",
    }),
    family = select(
      [
        { value: "new", label: "Create a family" },
        ...families.map((f) => ({ value: f.id, label: f.name })),
      ],
      families[0]?.id ?? "new",
    ),
    familyName = el("input", { value: "Experiments" }),
    slug = el("input", { value: "experiments" }),
    suffix = el("input", {
      required: true,
      placeholder: "diameters",
      pattern: "[a-zA-Z0-9][a-zA-Z0-9_\\-]{0,63}",
      maxLength: 64,
    }),
    route = el("code"),
    editor = fieldsEditor([{ key: "n", label: "n", type: "integer", required: true }]),
    errors = el("div");
  form.append(
    el(
      "div",
      { class: "form-grid" },
      labeled("Pool name", name),
      labeled("Family", family),
      labeled("New family name", familyName),
      labeled("New family route", slug),
      labeled("Worker route suffix", suffix),
      labeled("Description", description),
    ),
    el(
      "p",
      { class: "input-note" },
      "Workers will use ",
      route,
      ". This creates a profile pointing to this pool. Display names can change without changing this route.",
    ),
    el("h3", { style: "margin-top:22px" }, "Input and result columns"),
    editor.host,
    button("+ Add column", editor.add),
    errors,
    el(
      "div",
      { class: "form-actions" },
      button("Cancel", () => d.dialog.close()),
      el("button", { type: "submit", class: "primary" }, "Create pool"),
    ),
  );
  let customSuffix = false;
  const updateRoute = () => {
    const creatingFamily = family.value === "new";
    familyName.parentElement!.hidden = !creatingFamily;
    slug.parentElement!.hidden = !creatingFamily;
    familyName.required = creatingFamily;
    slug.required = creatingFamily;
    const prefix = creatingFamily ? slug.value : families.find((f) => f.id === family.value)?.slug;
    route.textContent = `${prefix || "family"}/${suffix.value || "suffix"}`.toLowerCase();
  };
  name.addEventListener("input", () => {
    if (!customSuffix)
      suffix.value = name.value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^[^a-z0-9]+|-+$/g, "")
        .slice(0, 64);
    updateRoute();
  });
  suffix.addEventListener("input", () => {
    customSuffix = true;
    updateRoute();
  });
  family.addEventListener("change", updateRoute);
  slug.addEventListener("input", updateRoute);
  updateRoute();
  form.onsubmit = async (e) => {
    e.preventDefault();
    errors.replaceChildren();
    try {
      let familyId = family.value;
      if (familyId === "new")
        familyId = (
          await api("/families", {
            ...operation(),
            name: familyName.value,
            slug: slug.value,
          })
        ).id;
      // Keep the newly created family selected if pool validation needs a retry.
      if (family.value === "new") {
        families.push({ id: familyId, name: familyName.value, slug: slug.value.toLowerCase() });
        family.append(el("option", { value: familyId }, familyName.value));
        family.value = familyId;
        updateRoute();
      }
      const pool = await api("/pools", {
        ...operation(),
        family_id: familyId,
        name: name.value,
        profile_slug: suffix.value,
        description: description.value,
        fields: editor.read(),
      });
      d.dialog.close();
      await done(pool.id);
    } catch (error) {
      errors.append(errorBox(error));
    }
  };
  d.content.append(form);
}
function policyEditor(policy: any, familyCaps = true) {
  const container = el("div", { class: "form-grid" }),
    controls = new Map<string, { mode: HTMLSelectElement; input: HTMLInputElement }>();
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!familyCaps && ["worker_family_cap", "family_cap"].includes(key)) continue;
    const unlimited = key.endsWith("_cap") || key === "max_attempts",
      mode = select(
        [
          {
            value: "inherit",
            label: `Inherit (default ${value ?? "unlimited"})`,
          },
          ...(unlimited && key !== "claim_cap" ? [{ value: "unlimited", label: "Unlimited" }] : []),
          { value: "value", label: "Set value" },
        ],
        Object.hasOwn(policy, key) ? (policy[key] === null ? "unlimited" : "value") : "inherit",
      ),
      input = el("input", {
        type: "number",
        min: key.includes("seconds") ? 1 : 0,
        value: policy[key] ?? value ?? 0,
      });
    controls.set(key, { mode, input });
    container.append(labeled(key.replaceAll("_", " "), el("div", {}, mode, input)));
  }
  return {
    container,
    read: () =>
      Object.fromEntries(
        [...controls]
          .filter(([, c]) => c.mode.value !== "inherit")
          .map(([k, c]) => [k, c.mode.value === "unlimited" ? null : Number(c.input.value)]),
      ),
  };
}
export async function configurationScreen(
  main: HTMLElement,
  state: any,
  refresh: () => Promise<void>,
) {
  main.append(
    el("h1", {}, "Pools & profiles"),
    el("p", { class: "muted" }, "Configure shared schemas and decide how workers receive tasks."),
    el(
      "p",
      { class: "input-note" },
      "A family supplies worker keys and defaults. A pool holds tasks and columns. A profile connects a family to one pool through a worker route.",
    ),
    el(
      "div",
      { class: "toolbar" },
      button("+ Create pool", () => createPoolDialog(state.families, async () => refresh())),
      button("+ Create profile", () => profileDialog(state, refresh)),
      labeled(
        "Show archived",
        el("input", {
          type: "checkbox",
          checked: showArchived(),
          onchange: async (event: Event) => {
            setShowArchived((event.target as HTMLInputElement).checked);
            await refresh();
          },
        }),
      ),
    ),
  );
  for (const [table, title, rows] of [
    ["families", "Families", state.families],
    ["pools", "Physical pools", state.pools],
    ["profiles", "Distribution profiles", state.profiles],
  ] as const) {
    const panel = el("section", { class: "panel" }, el("h2", {}, title)),
      grid = el("table", { class: "data-table" }),
      body = el("tbody"),
      drafts = new Map<string, any>();
    grid.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...[
            "Name / status",
            "Enabled",
            ...(table === "families"
              ? ["Default worker route"]
              : table === "pools"
                ? ["Owner family", "Worker routes / profiles"]
                : ["Family", "Target pool", "Worker route"]),
            "Actions",
          ].map((t) => el("th", {}, t)),
        ),
      ),
      body,
    );
    for (const row of rows.filter((row: any) => visibleConfiguration(state, table, row))) {
      const name = el("input", {
          value: row.name,
          "aria-label": `${row.name} name`,
          onchange: () => drafts.set(row.id, { ...drafts.get(row.id), name: name.value }),
        }),
        enabled = el("input", {
          type: "checkbox",
          checked: !!row.enabled,
          disabled: !!row.archived_at,
          "aria-label": `${row.name} enabled`,
          onchange: () =>
            drafts.set(row.id, {
              ...drafts.get(row.id),
              enabled: enabled.checked,
            }),
        }),
        actions = el(
          "td",
          { class: "configuration-actions" },
          button("Settings", () => configForm(table, row, state, refresh)),
          button(row.archived_at ? "Restore" : "Archive", () =>
            archiveConfiguration(table, row, state, refresh),
          ),
          button("Delete…", () => removalDialog(table, row, state, refresh)),
        );
      if (table === "pools")
        actions.append(
          button("Columns", () => schemaDialog(row, refresh)),
          button("Claim sort indexes", () => claimSortIndexes(row)),
        );
      body.append(
        el(
          "tr",
          {},
          el(
            "td",
            {},
            name,
            archiveReason(state, table, row)
              ? el("span", { class: "badge" }, archiveReason(state, table, row))
              : null,
          ),
          el("td", {}, enabled),
          ...(table === "families"
            ? [el("td", {}, configurationContext(table, row, state))]
            : table === "pools"
              ? [el("td", {}, familyLabel(state, row)), el("td", {}, poolRoutes(row, state))]
              : [
                  el("td", {}, familyLabel(state, row)),
                  el(
                    "td",
                    {},
                    state.pools.find((p: any) => p.id === row.pool_id)?.name ?? "Unknown pool",
                  ),
                  el("td", {}, routeDisplay(state, row)),
                ]),
          actions,
        ),
      );
    }
    const hiddenCount = rows.filter((row: any) => !visibleConfiguration(state, table, row)).length;
    if (hiddenCount)
      panel.append(
        el(
          "p",
          { class: "muted" },
          `${hiddenCount} archived items or items in archived families/pools hidden. Enable Show archived to inspect or restore them.`,
        ),
      );
    panel.append(
      el("div", { class: "table-scroll" }, grid),
      button(
        "Save configuration table",
        async () => {
          for (const [id, patch] of drafts) {
            const row = rows.find((r: any) => r.id === id);
            await api(
              `/${table}/${id}`,
              { ...operation(), expected_revision: row.config_revision, patch },
              "PATCH",
            );
          }
          toast("Configuration saved.");
          await refresh();
        },
        "primary",
      ),
    );
    main.append(panel);
  }
}
function familyLabel(state: ConfigurationState, row: any) {
  const family = familyFor(state, row);
  return el(
    "div",
    {},
    family?.name ?? "Unknown family",
    el("br"),
    el("code", {}, family?.slug ?? ""),
  );
}
function routeDisplay(state: ConfigurationState, profile: any) {
  const family = familyFor(state, profile);
  const pool = state.pools.find((p) => p.id === profile.pool_id);
  const unavailable =
    archiveReason(state, "profiles", profile) ||
    (!family?.enabled
      ? "Family disabled"
      : !pool?.enabled
        ? "Pool disabled"
        : !profile.enabled
          ? "Profile disabled"
          : "");
  return el(
    "div",
    { class: "route-detail" },
    el("code", {}, profileRoute(state, profile)),
    button("Copy route", async () => {
      await navigator.clipboard.writeText(profileRoute(state, profile));
      toast("Worker route copied.");
    }),
    family?.default_profile_id === profile.id
      ? el("small", {}, `Family default: ${family.slug}`)
      : null,
    unavailable ? el("small", {}, unavailable) : null,
  );
}
function poolRoutes(pool: any, state: ConfigurationState) {
  const profiles = state.profiles.filter((p) => p.pool_id === pool.id);
  return el(
    "div",
    { class: "configuration-context" },
    ...profiles.map((profile) =>
      el("div", {}, el("strong", {}, profile.name), routeDisplay(state, profile)),
    ),
    profiles.length ? null : el("p", {}, "No profiles. Create a profile to give workers access."),
  );
}
function configurationContext(table: string, row: any, state: ConfigurationState) {
  if (table === "families") {
    const profile = state.profiles.find((p) => p.id === row.default_profile_id);
    const pool = state.pools.find((p) => p.id === profile?.pool_id);
    return el(
      "div",
      { class: "configuration-context" },
      el("div", {}, "Family route: ", el("code", {}, row.slug)),
      profile
        ? el(
            "div",
            {},
            `Default: ${profile.name} → ${pool?.name ?? "Unknown pool"}`,
            routeDisplay(state, profile),
          )
        : el("p", {}, "No default profile. Choose one in Settings to use the bare family route."),
      el(
        "small",
        {},
        `${state.pools.filter((p) => p.owner_family_id === row.id).length} owned pools · ${state.profiles.filter((p) => p.family_id === row.id).length} profiles`,
      ),
    );
  }
  return el(
    "div",
    { class: "configuration-context" },
    el("div", {}, table === "pools" ? "Owner family: " : "Family: ", familyLabel(state, row)),
    table === "pools"
      ? poolRoutes(row, state)
      : el(
          "div",
          {},
          `Target pool: ${state.pools.find((p) => p.id === row.pool_id)?.name ?? "Unknown pool"}`,
          routeDisplay(state, row),
        ),
  );
}
async function archiveConfiguration(
  table: string,
  row: any,
  state: ConfigurationState,
  refresh: () => Promise<void>,
) {
  const restoring = !!row.archived_at;
  const d = dialog(`${restoring ? "Restore" : "Archive"} ${row.name}`, true);
  d.content.append(
    configurationContext(table, row, state),
    el(
      "p",
      {},
      restoring
        ? "Restore this item to the active lists. It stays disabled until you enable it. Archived parents must also be restored before it appears in the normal view."
        : "Stop new claims through this item and hide it from the normal lists. Existing leases can finish; tasks, results and history are retained. Use Show archived to find it again.",
    ),
    el(
      "p",
      { hidden: table !== "families" || restoring },
      "This stops this family's worker routes. Other families' profiles can still access its pools unless those pools are also archived.",
    ),
    button(
      restoring ? "Restore item" : "Archive item",
      async () => {
        await api(
          `/${table}/${row.id}`,
          {
            ...operation(),
            expected_revision: row.config_revision,
            patch: { archived: !restoring },
          },
          "PATCH",
        );
        d.dialog.close();
        await refresh();
      },
      "primary",
    ),
  );
}
async function removalDialog(
  table: string,
  row: any,
  state: ConfigurationState,
  refresh: () => Promise<void>,
) {
  const review = await api(`/${table}/${row.id}/removal`);
  const d = dialog(`Delete ${review.name}`, true);
  d.content.append(configurationContext(table, row, state));
  if (!review.can_delete) {
    d.content.append(
      el("p", {}, "This item cannot be permanently deleted:"),
      el("ul", {}, ...review.reasons.map((reason: string) => el("li", {}, reason))),
      el("p", {}, "Archiving retains its data and hides it from normal lists."),
    );
    if (!row.archived_at)
      d.content.append(
        button(
          "Archive instead",
          () => {
            d.dialog.close();
            return archiveConfiguration(table, row, state, refresh);
          },
          "primary",
        ),
      );
    return;
  }
  d.content.append(
    el(
      "p",
      {},
      "Permanently delete this unused item? This cannot be undone. An audit record of the deletion remains.",
    ),
  );
  if (table === "pools" && review.profiles.length)
    d.content.append(
      el("p", {}, "These unused profiles will also be deleted:"),
      el(
        "ul",
        {},
        ...review.profiles.map((p: any) => el("li", {}, `${p.name} (${profileRoute(state, p)})`)),
      ),
    );
  if (review.defaults.length)
    d.content.append(
      el(
        "p",
        {},
        `These families will have no default profile until you choose another in Settings: ${review.defaults.map((f: any) => f.name).join(", ")}.`,
      ),
    );
  if (review.revoked_key_count)
    d.content.append(
      el("p", {}, `${review.revoked_key_count} permanently revoked API keys will also be removed.`),
    );
  const errors = el("div");
  d.content.append(
    errors,
    button(
      "Delete permanently",
      async () => {
        try {
          await api(
            `/${table}/${row.id}`,
            {
              ...operation(),
              expected_revision: review.expected_revision,
              dependency_token: review.dependency_token,
            },
            "DELETE",
          );
          d.dialog.close();
          toast("Item deleted.");
          await refresh();
        } catch (error) {
          errors.replaceChildren(errorBox(error));
        }
      },
      "danger",
    ),
  );
}
function configForm(
  table: string,
  row: any,
  state: ConfigurationState,
  refresh: () => Promise<void>,
) {
  const d = dialog(`${row.name} settings`),
    name = el("input", { value: row.name }),
    description = el("textarea", { value: row.description ?? "" }),
    enabled = el("input", {
      type: "checkbox",
      checked: !!row.enabled,
      disabled: !!row.archived_at,
    }),
    policy = policyEditor(JSON.parse(row.policy_json ?? "{}"), table !== "profiles"),
    errors = el("div");
  const cap = el("input", {
      type: "number",
      min: 0,
      value: row.active_cap ?? "",
      placeholder: "Unlimited",
    }),
    attempts = el("input", {
      type: "number",
      min: 0,
      value: row.total_attempt_cap ?? "",
      placeholder: "Unlimited",
    }),
    required = el("input", {
      type: "checkbox",
      checked: !!row.required_result,
    }),
    filter = el("textarea", { value: row.mandatory_filter ?? "" }),
    projection = el("input", {
      value: row.projection_json ? JSON.parse(row.projection_json).join(", ") : "",
      placeholder: "All inputs when blank",
    }),
    allowlist = el("input", {
      value: JSON.parse(row.filter_allowlist_json ?? "[]").join(", "),
    });
  d.content.append(
    configurationContext(table, row, state),
    labeled("Name", name),
    labeled("Enabled", enabled),
  );
  if (row.archived_at)
    d.content.append(
      el("p", { class: "input-note" }, "Archived. Restore this item before enabling it."),
    );
  const defaultProfile = select(
    [
      { value: "", label: "No default profile" },
      ...state.profiles
        .filter((p) => p.family_id === row.id)
        .map((p) => ({
          value: p.id,
          label: `${p.name} → ${state.pools.find((pool) => pool.id === p.pool_id)?.name ?? "Unknown pool"} (${profileRoute(state, p)})${p.archived_at ? " · Archived" : !p.enabled ? " · Disabled" : ""}`,
        })),
    ],
    row.default_profile_id ?? "",
  );
  if (table === "families")
    d.content.append(
      labeled("Default profile", defaultProfile),
      el(
        "p",
        { class: "input-note" },
        `Workers using just ${row.slug} claim from this profile's pool. Explicit family/profile routes keep their own targets.`,
      ),
    );
  if (table !== "profiles") d.content.append(labeled("Description", description));
  if (table === "pools")
    d.content.append(
      el(
        "div",
        { class: "form-grid" },
        labeled("Physical active cap (blank = unlimited)", cap),
        labeled("Physical attempt cap (blank = unlimited)", attempts),
        labeled("Require a nonblank success result", required),
      ),
    );
  else d.content.append(policy.container);
  if (table === "profiles")
    d.content.append(
      labeled("Mandatory filter", filter),
      labeled("Returned input keys", projection),
      labeled("Allowed worker filter/sort fields", allowlist),
    );
  d.content.append(
    errors,
    el(
      "p",
      { class: "input-note" },
      "Disabling drains existing leases. Lower caps restrict new claims. Current attempts retain their issued result and lifetime contract.",
    ),
    button(
      "Save settings",
      async () => {
        try {
          const patch: any = { name: name.value, enabled: enabled.checked };
          if (table === "families") patch.default_profile_id = defaultProfile.value || null;
          if (table !== "profiles") patch.description = description.value;
          if (table === "pools")
            Object.assign(patch, {
              active_cap: cap.value === "" ? null : Number(cap.value),
              total_attempt_cap: attempts.value === "" ? null : Number(attempts.value),
              required_result: required.checked,
            });
          else patch.policy = policy.read();
          if (table === "profiles")
            Object.assign(patch, {
              mandatory_filter: filter.value,
              projection: projection.value
                ? projection.value
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean)
                : null,
              filter_allowlist: allowlist.value
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
            });
          await api(
            `/${table}/${row.id}`,
            { ...operation(), expected_revision: row.config_revision, patch },
            "PATCH",
          );
          d.dialog.close();
          await refresh();
        } catch (error) {
          errors.replaceChildren(errorBox(error));
        }
      },
      "primary",
    ),
  );
}
function profileDialog(state: any, refresh: () => Promise<void>) {
  const d = dialog("Create a profile"),
    family = select(
      state.families
        .filter((f: any) => !f.archived_at)
        .map((f: any) => ({ value: f.id, label: `${f.name} (${f.slug})` })),
    ),
    pool = select(
      state.pools
        .filter((p: any) => !p.archived_at)
        .map((p: any) => ({ value: p.id, label: `${familyFor(state, p)?.name} / ${p.name}` })),
    ),
    name = el("input", { placeholder: "GPU workers" }),
    slug = el("input", { placeholder: "gpu" }),
    filter = el("input", { placeholder: "has:gpu" }),
    policy = policyEditor({}, false);
  const route = el("code");
  const updateRoute = () => {
    route.textContent =
      `${state.families.find((f: any) => f.id === family.value)?.slug ?? "family"}/${slug.value || "suffix"}`.toLowerCase();
  };
  family.addEventListener("change", updateRoute);
  slug.addEventListener("input", updateRoute);
  updateRoute();
  d.content.append(
    el(
      "div",
      { class: "form-grid" },
      labeled("Family", family),
      labeled("Physical pool", pool),
      labeled("Name", name),
      labeled("Route suffix", slug),
      labeled("Mandatory filter", filter),
    ),
    el("p", { class: "input-note" }, "Worker route: ", route),
    policy.container,
    button(
      "Create profile",
      async () => {
        const fields = (await api(`/pools/${pool.value}/fields`)).fields;
        await api("/profiles", {
          ...operation(),
          family_id: family.value,
          pool_id: pool.value,
          name: name.value,
          slug: slug.value,
          mandatory_filter: filter.value,
          policy: policy.read(),
          filter_allowlist: [
            ...fields.filter((f: any) => f.kind === "input").map((f: any) => f.key),
            "attempts",
            "status",
            "task_id",
          ],
        });
        d.dialog.close();
        await refresh();
      },
      "primary",
    ),
  );
}
async function schemaDialog(pool: any, refresh: () => Promise<void>) {
  if (pool.migration_status === "migrating") {
    const operations = await api(`/operations?pool_id=${pool.id}&kind=schema`),
      op = operations.rows.find((o: any) => o.status === "applying");
    if (op) {
      await schemaReview(
        pool,
        {
          operation_id: op.id,
          incompatible: true,
          explanation:
            "Resume the saved schema migration. Valid rows stay committed; correct rejected rows before activation.",
        },
        refresh,
      );
      return;
    }
  }
  const fields = (await api(`/pools/${pool.id}/fields`)).fields,
    editor = fieldsEditor(fields),
    d = dialog("Edit pool columns"),
    errors = el("div");
  d.content.append(
    editor.host,
    button("+ Add column", editor.add),
    el(
      "p",
      { class: "input-note" },
      "Labels, order, and optional additions can apply immediately. Incompatible changes use a reviewed migration and block claims until all rows validate.",
    ),
    errors,
    button(
      "Preview schema change",
      async () => {
        try {
          const p = await api(`/pools/${pool.id}/fields/preview`, {
            ...operation(),
            expected_revision: pool.config_revision,
            fields: editor.read(),
          });
          d.dialog.close();
          await schemaReview(pool, p, refresh);
        } catch (error) {
          errors.replaceChildren(errorBox(error));
        }
      },
      "primary",
    ),
  );
}
async function schemaReview(pool: any, preview: any, refresh: () => Promise<void>) {
  const review = dialog("Review schema changes"),
    revoke = el("input", { type: "checkbox" }),
    progress = el("p"),
    corrections = el("div");
  review.content.append(
    el("p", {}, preview.explanation),
    labeled("Revoke affected active leases", revoke),
    progress,
    corrections,
    button(
      "Apply / resume migration",
      async () => {
        corrections.replaceChildren();
        let result: any;
        do {
          result = await api(`/pools/${pool.id}/fields/apply`, {
            ...operation(),
            operation_id: preview.operation_id,
            revoke: revoke.checked,
          });
          progress.textContent = `${result.processed ?? 0} of ${result.total ?? "all"} rows validated · ${result.status}`;
        } while (result.status === "migrating" && review.dialog.open);
        if (result.status === "complete") {
          review.dialog.close();
          await refresh();
          return;
        }
        if (result.status === "needs_correction") {
          const op = await api(`/operations/${preview.operation_id}`);
          corrections.append(
            el(
              "p",
              {},
              "The pool remains closed to claims and input edits. Correct each rejected row, then resume. You may close this window and resume from Columns later.",
            ),
          );
          for (const item of result.errors) {
            const task = (await api(`/tasks/${item.task_uid}`)).task,
              box = el("section", { class: "panel" }),
              controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
            box.append(el("h3", {}, task.task_id), el("p", { class: "error-text" }, item.error));
            const fields = (op.action.fields as Field[]).filter(
              (f) => f.kind === "input" && f.active,
            );
            for (const field of fields) {
              const old = op.action.old_fields.find((f: Field) => f.id === field.id),
                value = task.data[old?.key ?? field.key] ?? field.default;
              const control =
                field.type === "json"
                  ? el("textarea", { value: value === undefined ? "" : stringify(value) })
                  : el("input", { value: value === undefined ? "" : String(value) });
              controls.set(field.key, control);
              box.append(labeled(`${field.label} (${field.type})`, control));
            }
            box.append(
              button("Save correction", async () => {
                const data: Record<string, unknown> = {};
                for (const field of fields) {
                  const value = controls.get(field.key)!.value;
                  if (value === "" && !field.required) continue;
                  data[field.key] = inputValue(value, field);
                }
                await api(`/pools/${pool.id}/fields/correct`, {
                  ...operation(),
                  operation_id: preview.operation_id,
                  task_uid: item.task_uid,
                  data,
                });
                box.replaceChildren(
                  el("p", {}, `${task.task_id}: correction saved. Resume migration when ready.`),
                );
              }),
            );
            corrections.append(box);
          }
        }
      },
      "primary",
    ),
  );
}
export async function keysScreen(main: HTMLElement, families: any[]) {
  main.append(
    el("h1", {}, "API keys"),
    el(
      "p",
      { class: "muted" },
      "Each key authorizes one family. Secrets appear once and are never stored in browser preferences.",
    ),
  );
  const family = select(families.map((f) => ({ value: f.id, label: f.name }))),
    label = el("input", {
      placeholder: "Laptop, Kaggle, cluster…",
      "aria-label": "Key label",
    });
  main.append(
    el(
      "div",
      { class: "toolbar" },
      family,
      label,
      button(
        "Issue family key",
        async () => {
          const result = await api("/keys", {
            ...operation(),
            family_id: family.value,
            label: label.value,
          });
          showSecret(result);
          main.replaceChildren();
          await keysScreen(main, families);
        },
        "primary",
      ),
    ),
  );
  const keys = await apiRows("/keys"),
    table = el(
      "table",
      { class: "data-table" },
      el(
        "thead",
        {},
        el("tr", {}, ...["Label", "Family", "Status", "Actions"].map((t) => el("th", {}, t))),
      ),
    ),
    body = el("tbody");
  for (const key of keys.rows)
    body.append(
      el(
        "tr",
        {},
        el("td", {}, key.label, el("br"), el("small", {}, key.prefix)),
        el("td", {}, families.find((f) => f.id === key.family_id)?.name ?? ""),
        el("td", {}, key.status),
        el(
          "td",
          {},
          button("Rotate", async () => {
            const result = await api(`/keys/${key.id}/rotate`, {
              ...operation(),
              label: `${key.label} replacement`,
            });
            showSecret(result);
            main.replaceChildren();
            await keysScreen(main, families);
          }),
          ...["soft-revoke", "hard-revoke"].map((action) =>
            button(
              action === "soft-revoke" ? "Soft revoke" : "Hard revoke",
              () => {
                const d = dialog("Review key revocation", true),
                  reason = el("input", { placeholder: "Reason" });
                d.content.append(
                  el(
                    "p",
                    {},
                    action === "hard-revoke"
                      ? "Existing leases become ineffective immediately. No reports or replay will be accepted with this key."
                      : "New claims and renewals stop. Existing work may report until its current lease expires.",
                  ),
                  labeled("Reason", reason),
                  button(
                    "Revoke key",
                    async () => {
                      await api(`/keys/${key.id}/${action}`, {
                        ...operation(),
                        reason: reason.value || "Administrator revocation",
                      });
                      d.dialog.close();
                      main.replaceChildren();
                      await keysScreen(main, families);
                    },
                    "danger",
                  ),
                );
              },
              action === "hard-revoke" ? "danger" : "",
            ),
          ),
        ),
      ),
    );
  table.append(body);
  main.append(el("div", { class: "panel table-scroll" }, table));
}
function showSecret(result: any) {
  const d = dialog("Copy your new key", true);
  if (!result.secret_available) {
    d.content.append(
      el(
        "p",
        {},
        "This is a replay of a key creation request. The secret cannot be recovered. Revoke this key and issue another if the first response was lost.",
      ),
    );
    return;
  }
  const secret = el("input", {
    value: result.key,
    readOnly: true,
    style: "width:100%",
  });
  d.content.append(
    el("p", {}, "This secret is shown once. Keep it in your worker environment."),
    secret,
    button("Copy key", async () => {
      await navigator.clipboard.writeText(result.key);
      toast("Key copied.");
    }),
    el("pre", {}, `export TASK_MANAGER_KEY='${result.key}'`),
  );
  d.dialog.addEventListener("close", () => {
    secret.value = "";
    result.key = undefined;
  });
}
export async function settingsScreen(main: HTMLElement, refresh: () => Promise<void>) {
  const settings = await api("/settings"),
    policy = policyEditor(settings.defaults),
    panel = el("section", { class: "panel" });
  main.append(
    el("h1", {}, "Settings"),
    el("p", { class: "muted" }, "Defaults, deployment health, and recovery controls."),
  );
  panel.append(
    el("h2", {}, "Deployment"),
    el(
      "p",
      {},
      `Application ${settings.version} · schema ${settings.schema_version} · ${settings.environment}`,
    ),
    el(
      "p",
      {},
      `${settings.counts.tasks} tasks · ${settings.counts.attempts} attempts · ${(settings.estimated_bytes / 1048576).toFixed(1)} MiB estimated database size`,
    ),
    el(
      "p",
      {},
      settings.epoch_matches
        ? "Installation epoch matches."
        : "Epoch mismatch: keep traffic closed and activate the new recovery generation.",
    ),
    el("p", {}, `Broker: https://${settings.broker_hostname}`),
    el("details", {}, el("summary", {}, "Diagnostics"), el("pre", {}, stringify(settings))),
  );
  main.append(
    panel,
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "Global defaults"),
      policy.container,
      button(
        "Save defaults",
        async () => {
          await api(
            "/settings",
            {
              ...operation(),
              expected_revision: settings.config_revision,
              defaults: policy.read(),
            },
            "PATCH",
          );
          await refresh();
        },
        "primary",
      ),
    ),
  );
  const admins = await apiRows("/administrators"),
    adminPanel = el("section", { class: "panel" }, el("h2", {}, "Administrators"));
  for (const a of admins.rows)
    adminPanel.append(el("p", {}, `${a.email} · ${a.active ? "active" : "disabled"}`));
  const subject = el("input", { placeholder: "Verified Access subject ID" }),
    email = el("input", {
      type: "email",
      placeholder: "colleague@example.com",
    });
  adminPanel.append(
    el(
      "div",
      { class: "toolbar" },
      subject,
      email,
      button("Add administrator", async () => {
        await api("/administrators", {
          ...operation(),
          subject: subject.value,
          email: email.value,
        });
        await refresh();
      }),
    ),
    el(
      "p",
      { class: "input-note" },
      "Deployment owners retain access independently of this list. The Access edge policy must also permit each administrator.",
    ),
  );
  main.append(adminPanel);
  main.append(button("Import a portable installation", portableImport));
  const maintenance = el(
    "section",
    { class: "panel" },
    el("h2", {}, "Backup and recovery"),
    el(
      "p",
      {},
      "Maintenance blocks worker reports and renewals as well as browser writes. Tell active workers before taking a consistent backup.",
    ),
    button(
      settings.maintenance ? "Leave maintenance" : "Enter maintenance",
      async () => {
        await api("/maintenance", {
          ...operation(),
          maintenance: !settings.maintenance,
        });
        await refresh();
      },
      settings.maintenance ? "primary" : "danger",
    ),
    button(
      "Activate configured recovery epoch",
      async () => {
        await api("/epoch/activate", {
          ...operation(),
          reason: "Owner-confirmed database recovery",
        });
        await refresh();
      },
      "danger",
    ),
    button("Portable installation export", async () => {
      const { portableExport } = await import("./transfer");
      await portableExport();
    }),
    el(
      "p",
      { class: "input-note" },
      "For native backups and Time Travel restoration, use the supplied operations manual and the Cloudflare dashboard. Rotate INSTANCE_EPOCH after restoring or cloning a database.",
    ),
  );
  main.append(maintenance);
}

async function claimSortIndexes(pool: any) {
  const d = dialog(`Claim sort indexes · ${pool.name}`),
    fields = (await api(`/pools/${pool.id}/fields`)).fields as Field[];
  const name = el("input", { "aria-label": "Index name", placeholder: "e.g. category then size" });
  const fieldChoices = [
    ...["task_id", "enabled", "admin_note", "attempts_total"].map((key) => ({
      value: key,
      label: key,
    })),
    ...fields
      .filter((f) => f.active && f.kind === "input" && f.type !== "json")
      .map((f) => ({ value: f.key, label: f.label })),
  ];
  const editor = el("div"),
    rows: { node: HTMLElement; field: HTMLSelectElement; direction: HTMLSelectElement }[] = [];
  function addField() {
    if (rows.length >= 8) throw new Error("Up to eight fields are supported.");
    const field = select(fieldChoices),
      direction = select([
        { value: "asc", label: "Ascending" },
        { value: "desc", label: "Descending" },
      ]);
    field.setAttribute("aria-label", "Index sort field");
    direction.setAttribute("aria-label", "Index sort direction");
    const node = el("div", { class: "toolbar" }, field, direction),
      row = { node, field, direction };
    node.append(
      button("Remove field", () => {
        rows.splice(rows.indexOf(row), 1);
        node.remove();
      }),
    );
    rows.push(row);
    editor.append(node);
  }
  const list = el("div");
  async function refresh() {
    const result = await api(`/pools/${pool.id}/claim-sort-indexes`);
    list.replaceChildren();
    for (const index of result.rows) {
      const description = index.sorts
        .map((s: any) => `${s.field} ${s.direction === "asc" ? "↑" : "↓"}`)
        .join(" → ");
      const panel = el(
        "section",
        { class: "panel" },
        el("h3", {}, index.name),
        el("p", {}, `${description} · ${index.status}`),
      );
      const actions = el("div", { class: "toolbar" });
      if (index.status !== "invalid")
        actions.append(
          button(index.status === "ready" ? "Rebuild index" : "Build index", async () => {
            await api(`/claim-sort-indexes/${index.id}/build`, {
              ...operation(),
              expected_revision: index.revision,
            });
            await refresh();
          }),
        );
      actions.append(
        button("Delete index", async () => {
          await api(
            `/claim-sort-indexes/${index.id}`,
            { ...operation(), expected_revision: index.revision },
            "DELETE",
          );
          await refresh();
        }),
      );
      panel.append(
        actions,
        el(
          "pre",
          {},
          `client.claim(20, sort=[${index.sorts.map((s: any) => `(${JSON.stringify(s.field)}, ${JSON.stringify(s.direction)})`).join(", ")}])`,
        ),
      );
      if (index.status === "invalid")
        panel.append(
          el(
            "p",
            {},
            "A field was removed or no longer supports this index. Delete this definition and configure a replacement.",
          ),
        );
      list.append(panel);
    }
    if (!result.rows.length)
      list.append(el("p", { class: "muted" }, "No claim sort indexes configured."));
  }
  addField();
  d.content.append(
    el(
      "p",
      {},
      "Prepare up to four frequently used claim orders per pool. Fresh tasks remain first; retries retain oldest-grant priority. Indexes update automatically when tasks change. Other requested orders still work without an index.",
    ),
    list,
    el("h3", {}, "Configure an index"),
    labeled("Index name", name),
    editor,
    button("Add sort field", addField),
    button(
      "Save index definition",
      async () => {
        if (!rows.length) throw new Error("Choose at least one sort field.");
        const markSaved = d.savedChanges();
        const savedName = name.value;
        await api(`/pools/${pool.id}/claim-sort-indexes`, {
          ...operation(),
          name: savedName,
          sorts: rows.map((r) => ({ field: r.field.value, direction: r.direction.value })),
        });
        if (name.value === savedName) name.value = "";
        markSaved();
        await refresh();
      },
      "primary",
    ),
  );
  await refresh();
}
