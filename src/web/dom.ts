export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key in node && key !== "form")
      try {
        (node as any)[key] = value;
      } catch {
        node.setAttribute(key, String(value));
      }
    else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child !== undefined && child !== null) node.append(child);
  return node;
}
export function button(text: string, run: () => unknown, cls = "") {
  return el(
    "button",
    {
      type: "button",
      class: cls,
      onclick: async (event: Event) => {
        const target = event.currentTarget as HTMLButtonElement;
        target.disabled = true;
        try {
          await run();
        } catch (error) {
          notifyError(error);
        } finally {
          target.disabled = false;
        }
      },
    },
    text,
  );
}
export function toast(message: string) {
  const node = el("div", { class: "toast" }, message);
  document.querySelector("#notifications")!.append(node);
  setTimeout(() => node.remove(), 7000);
}
export function notifyError(error: unknown) {
  toast(error instanceof Error ? error.message : String(error));
}
export function errorBox(error: unknown) {
  const message = error instanceof Error ? error.message : String(error),
    box = el("div", { class: "error-text", role: "alert" }, message);
  if ((error as any)?.status === 401)
    box.append(
      el(
        "a",
        {
          href: `${location.origin}/admin/`,
          target: "_blank",
          rel: "noopener",
          class: "login-link",
        },
        "Sign in in another tab",
      ),
    );
  return box;
}
export function dialog(title: string, narrow = false) {
  const d = el("dialog", { class: narrow ? "narrow" : "" }),
    content = el("div");
  const close = button("Close", () => {
    if (!d.dataset.dirty || confirm("Discard the unsaved changes in this form?")) d.close();
  });
  close.setAttribute("aria-label", "Close dialog");
  const titleId = `dialog-${crypto.randomUUID()}`;
  d.setAttribute("aria-labelledby", titleId);
  d.append(el("header", {}, el("h2", { id: titleId }, title), close), content);
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.addEventListener("input", () => {
    d.dataset.dirty = "true";
  });
  d.addEventListener("cancel", (event) => {
    if (d.dataset.dirty && !confirm("Discard the unsaved changes in this form?"))
      event.preventDefault();
  });
  d.showModal();
  return { dialog: d, content };
}
window.addEventListener("beforeunload", (event) => {
  if (document.querySelector('dialog[data-dirty="true"]')) {
    event.preventDefault();
    event.returnValue = "";
  }
});
export function labeled(name: string, input: HTMLElement) {
  return el("label", {}, name, input);
}
export function select(options: { value: string; label: string }[], value?: string) {
  const s = el("select");
  for (const o of options) s.append(el("option", { value: o.value }, o.label));
  if (value !== undefined) s.value = value;
  return s;
}
export function download(name: string, parts: BlobPart[], type: string) {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const a = el("a", { href: url, download: name }, "Download");
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export const stringify = (x: unknown) => JSON.stringify(x, null, 2);
