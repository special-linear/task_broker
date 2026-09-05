import Papa from "papaparse";
import { api, operation } from "./api";
import { button, dialog, download, el, errorBox, labeled, select, stringify, toast } from "./dom";
import { inputValue } from "./grid";
import { sha256, parseJSON, type Field } from "../shared/core";
import type { TaskRow } from "../shared/contracts";
export function parseTable(text: string): Promise<{ rows: string[][]; errors: any[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./import.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e) => {
      resolve(e.data);
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(new Error(e.message));
      worker.terminate();
    };
    worker.postMessage({ text });
  });
}
export function importDialog(
  poolId: string,
  fields: Field[],
  refresh: () => Promise<void>,
  initial = "",
) {
  const d = dialog("Import tasks or paste a table"),
    text = el("textarea", {
      rows: 8,
      value: initial,
      placeholder: "Paste a rectangle from Sheets/Excel, or choose a UTF-8 CSV file.",
      style: "width:100%",
    }),
    file = el("input", {
      type: "file",
      accept: ".csv,.tsv,text/csv,text/tab-separated-values",
    }),
    mode = select([
      { value: "add", label: "Add new tasks" },
      { value: "update", label: "Update by ID" },
      { value: "upsert", label: "Upsert (explicit)" },
      { value: "legacy", label: "Reviewed legacy migration" },
    ]),
    preview = el("div"),
    errors = el("div");
  file.onchange = async () => {
    if (file.files?.[0]) text.value = await file.files[0].text();
  };
  d.content.append(
    el(
      "p",
      { class: "input-note" },
      "Text columns preserve leading zeros. Empty numeric/boolean/date cells become null when nullable. Booleans accept true/false or 1/0. Dates require ISO datetimes. Formulas remain text.",
    ),
    file,
    text,
    labeled("Import mode", mode),
    button("Parse and preview", async () => {
      preview.replaceChildren();
      errors.replaceChildren();
      try {
        const parsed = await parseTable(text.value);
        if (parsed.errors.length)
          throw new Error(parsed.errors.map((e) => `Row ${e.row}: ${e.message}`).join("\n"));
        if (parsed.rows.length < 2)
          throw new Error("Include a header row and at least one data row.");
        const [headers, ...rows] = parsed.rows;
        if (rows.length > 10000) throw new Error("Split this import into at most 10,000 rows.");
        const mappings = headers.map((header, i) =>
          select(
            [
              { value: "", label: "Skip column" },
              { value: "task_id", label: "Task ID" },
              { value: "tags", label: "Tags" },
              { value: "enabled", label: "Enabled" },
              ...(mode.value === "legacy"
                ? [
                    { value: "legacy_result", label: "Imported raw result (JSON)" },
                    { value: "legacy_completed", label: "Imported completed flag" },
                    { value: "legacy_attempts", label: "Historical attempt count" },
                  ]
                : []),
              ...fields
                .filter((f) => f.kind === "input")
                .map((f) => ({
                  value: f.key,
                  label: `${f.label} (${f.type})`,
                })),
            ],
            header === "task_id"
              ? "task_id"
              : header === "tags"
                ? "tags"
                : (fields.find(
                    (f) =>
                      f.key.toLowerCase() === header.toLowerCase() ||
                      f.label.toLowerCase() === header.toLowerCase(),
                  )?.key ?? ""),
          ),
        );
        const table = el(
            "table",
            { class: "data-table" },
            el("thead", {}, el("tr", {}, ...headers.map((h, i) => el("th", {}, h, mappings[i])))),
          ),
          body = el("tbody");
        for (const row of rows.slice(0, 6))
          body.append(el("tr", {}, ...headers.map((_, i) => el("td", {}, row[i] ?? ""))));
        table.append(body);
        preview.append(
          el("h3", {}, `${rows.length.toLocaleString()} rows detected`),
          el("div", { class: "table-scroll" }, table),
        );
        let stagedId: string | undefined;
        const progress = el("progress", {
            class: "progress",
            max: rows.length,
            value: 0,
          }),
          status = el("p");
        preview.append(
          progress,
          status,
          button("Validate complete import", async () => {
            errors.replaceChildren();
            try {
              const selected = mappings.map((m) => m.value).filter(Boolean);
              if (new Set(selected).size !== selected.length)
                throw new Error("Each target field may be mapped only once.");
              const converted: any[] = [],
                invalid: any[] = [];
              for (let ix = 0; ix < rows.length; ix++) {
                const raw = rows[ix],
                  item: any = { data: {} };
                let valid = true;
                for (let col = 0; col < headers.length; col++) {
                  const target = mappings[col].value;
                  if (!target) continue;
                  try {
                    if (target === "task_id") {
                      if (raw[col]) item.task_id = raw[col];
                    } else if (target === "legacy_result")
                      item.legacy_result = parseJSON(raw[col] || "null");
                    else if (target === "legacy_completed" || target === "enabled") {
                      if (
                        !["true", "false", "1", "0", ""].includes(
                          (raw[col] ?? "").trim().toLowerCase(),
                        )
                      )
                        throw new Error("Use true/false or 1/0.");
                      item[target] = ["true", "1"].includes((raw[col] ?? "").trim().toLowerCase());
                    } else if (target === "legacy_attempts") {
                      const n = Number(raw[col]);
                      if (!Number.isSafeInteger(n) || n < 0)
                        throw new Error("Use a nonnegative integer count.");
                      item.legacy_attempts = n;
                    } else if (target === "tags")
                      item.tags = (raw[col] ?? "").split(",").filter(Boolean);
                    else {
                      const field = fields.find((f) => f.key === target)!;
                      if (raw[col] === undefined) continue;
                      item.data[target] = inputValue(raw[col], field);
                    }
                  } catch (e) {
                    valid = false;
                    invalid.push({
                      row: ix + 2,
                      task_id: item.task_id ?? "",
                      column: headers[col],
                      error: e instanceof Error ? e.message : String(e),
                    });
                  }
                }
                if (valid) converted.push(item);
              }
              if (invalid.length) {
                download("import-errors.csv", [Papa.unparse(invalid)], "text/csv");
                throw new Error(
                  `${invalid.length} invalid values. Correct them before saving; an error CSV was downloaded.`,
                );
              }
              const p = await api("/imports/preview", {
                ...operation(),
                pool_id: poolId,
                mode: mode.value,
                total: converted.length,
                mapping: Object.fromEntries(headers.map((h, i) => [h, mappings[i].value])),
              });
              stagedId = p.operation_id;
              for (let start = 0; start < converted.length;) {
                let chunk = converted.slice(start, start + 50);
                while (
                  new TextEncoder().encode(JSON.stringify(chunk)).length > 480000 &&
                  chunk.length > 1
                )
                  chunk = chunk.slice(0, Math.ceil(chunk.length / 2));
                await api(`/imports/${stagedId}/preview-chunks`, {
                  ...operation(),
                  start,
                  rows: chunk,
                });
                start += chunk.length;
                progress.value = start;
                status.textContent = `Validated ${start} of ${converted.length}`;
              }
              const op = await api(`/operations/${stagedId}`),
                rejected = op.counts.find((c: any) => c.status === "rejected")?.count ?? 0;
              status.textContent = `${op.total - rejected} ready, ${rejected} rejected. Review the first rows below, then Save.`;
              preview.append(
                el(
                  "pre",
                  {},
                  op.items
                    .slice(0, 20)
                    .map(
                      (i: any) =>
                        `Row ${i.ordinal + 2}: ${i.status}${i.outcome?.error ? ` — ${i.outcome.error}` : ""}`,
                    )
                    .join("\n"),
                ),
              );
            } catch (error) {
              errors.replaceChildren(errorBox(error));
            }
          }),
          button(
            "Save reviewed import",
            async () => {
              if (!stagedId) throw new Error("Validate the complete import first.");
              let done = 0;
              const failures: any[] = [];
              while (true) {
                const result = await api(`/imports/${stagedId}/chunks`, {
                  ...operation(),
                  limit: 50,
                });
                if (!result.items.length) break;
                for (const i of result.items)
                  if (i.status === "rejected")
                    failures.push({
                      row: i.ordinal + 2,
                      task_id: i.task_uid,
                      column: "",
                      error: i.error,
                    });
                done += result.items.length;
                progress.value = done;
                status.textContent = `${done} processed, ${failures.length} rejected`;
              }
              if (failures.length)
                download("import-save-errors.csv", [Papa.unparse(failures)], "text/csv");
              toast("Import finished. Committed rows are available in the task table.");
              await refresh();
            },
            "primary",
          ),
        );
      } catch (error) {
        errors.replaceChildren(errorBox(error));
      }
    }),
    preview,
    errors,
  );
}
function safeCell(value: unknown): unknown {
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(value)) return `'${value}`;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value ?? "";
}
export function exportDialog(
  poolId: string,
  profileId: string,
  fields: Field[],
  filter: string,
  selected: TaskRow[],
) {
  const d = dialog("Export tasks", true),
    selection = select([
      { value: "view", label: "All rows matching the current view" },
      { value: "all", label: "All tasks in this pool" },
      { value: "selected", label: `Selected loaded rows (${selected.length})` },
    ]),
    format = select([
      { value: "csv", label: "Spreadsheet-safe CSV" },
      { value: "ndjson", label: "Lossless NDJSON" },
      { value: "json", label: "Lossless JSON" },
    ]),
    progress = el("p"),
    history = el("input", { type: "checkbox" });
  d.content.append(
    labeled("Selection", selection),
    labeled("Format", format),
    labeled("Export immutable attempt history (JSON or NDJSON)", history),
    el(
      "p",
      { class: "input-note" },
      "Task IDs are frozen at the start. Values are read live in pages and may change while downloading. Safe CSV prefixes formula-like text; JSON preserves exact strings.",
    ),
    progress,
    button(
      "Download",
      async () => {
        if (history.checked && format.value === "csv")
          throw new Error("Choose JSON or NDJSON for complete attempt history.");
        const selectedIds =
          selection.value === "selected" ? selected.map((t) => t.task_uid) : undefined;
        if (selectedIds && !selectedIds.length) throw new Error("No loaded rows are selected.");
        const preview = await api("/exports", {
          ...operation(),
          pool_id: poolId,
          history: history.checked,
          ...(profileId ? { profile_id: profileId } : {}),
          selection: {
            filter: selection.value === "view" ? filter : "",
            ...(selectedIds ? { ids: selectedIds } : {}),
          },
        });
        const parts: string[] = [],
          hashes: string[] = [];
        let count = 0,
          after = -1,
          sequence = 0,
          manifest: any;
        const columns = [
          "task_id",
          "enabled",
          ...fields.filter((f) => f.kind === "input").map((f) => f.key),
          "tags",
          "status",
          "attempts_total",
          "completed_at",
          ...fields.filter((f) => f.kind === "result").map((f) => f.key),
        ];
        if (format.value === "csv") parts.push(Papa.unparse([columns]) + "\r\n");
        if (format.value === "json") parts.push('{"rows":[');
        while (true) {
          const page = await api(
            `/exports/${preview.operation_id}/pages?after=${after}&sequence=${sequence}`,
          );
          manifest = page.manifest;
          let chunk: string;
          if (format.value === "csv")
            chunk =
              Papa.unparse(
                page.rows.map((r: any) =>
                  columns.map((key) =>
                    safeCell(
                      key === "tags"
                        ? r.tags.join(", ")
                        : Object.hasOwn(r, key)
                          ? r[key]
                          : Object.hasOwn(r.data, key)
                            ? r.data[key]
                            : r.result?.[key],
                    ),
                  ),
                ),
              ) + "\r\n";
          else
            chunk = page.rows
              .map(
                (r: any, i: number) =>
                  (format.value === "json" && count + i > 0 ? "," : "") +
                  JSON.stringify(r) +
                  (format.value === "ndjson" ? "\n" : ""),
              )
              .join("");
          parts.push(chunk);
          hashes.push(await sha256(chunk));
          count += page.rows.length;
          progress.textContent = `Exported ${count.toLocaleString()} rows`;
          if (page.next === null) break;
          after = page.next;
          sequence = page.sequence ?? 0;
        }
        manifest = {
          ...manifest,
          row_count: count,
          chunk_sha256: hashes,
          checksum_scheme: "SHA-256 of each UTF-8 data chunk in order",
          finished_at: new Date().toISOString(),
        };
        if (format.value === "json") parts.push(`],"manifest":${JSON.stringify(manifest)}}`);
        if (format.value === "ndjson")
          parts.unshift(JSON.stringify({ record_type: "manifest", ...manifest }) + "\n");
        download(
          `tasks-${new Date().toISOString().slice(0, 10)}.${format.value}`,
          parts,
          format.value === "csv" ? "text/csv;charset=utf-8" : "application/json",
        );
        d.content.append(
          button("Download export manifest", () =>
            download("export-manifest.json", [stringify(manifest)], "application/json"),
          ),
        );
      },
      "primary",
    ),
  );
}
export async function portableExport() {
  const d = dialog("Portable installation export", true),
    status = el("p", {}, "Preparing export…");
  d.content.append(status);
  const manifest = await api("/portable-export"),
    parts = [JSON.stringify({ record_type: "manifest", ...manifest }) + "\n"];
  let count = 0;
  const chunks: { table: string; count: number; sha256: string }[] = [],
    counts: Record<string, number> = {};
  for (const table of manifest.tables) {
    let after = "";
    while (true) {
      const result = await api(
        `/portable-export/pages?table=${encodeURIComponent(table)}&after=${encodeURIComponent(after)}`,
      );
      const chunk = result.rows
        .map((data: unknown) => JSON.stringify({ record_type: table, data }) + "\n")
        .join("");
      parts.push(chunk);
      count += result.rows.length;
      counts[table] = (counts[table] ?? 0) + result.rows.length;
      chunks.push({ table, count: result.rows.length, sha256: await sha256(chunk) });
      status.textContent = `${count} records exported`;
      if (!result.next) break;
      after = result.next;
    }
  }
  parts.push(
    JSON.stringify({
      record_type: "checksums",
      total_records: count,
      counts,
      chunks,
      checksum_scheme:
        "SHA-256 of exact UTF-8 NDJSON record chunks, including newline after every record",
      finished_at: new Date().toISOString(),
    }) + "\n",
  );
  download("task-broker-portable.ndjson", parts, "application/x-ndjson");
}
export function portableImport() {
  const d = dialog("Import a portable installation"),
    file = el("input", { type: "file", accept: ".ndjson" }),
    status = el("p"),
    review = el("div");
  d.content.append(
    el(
      "p",
      {},
      "Use an empty installation in maintenance mode. Imported pools and profiles are disabled; old keys and live leases cannot be used. Counts and checksums are verified before applying any records.",
    ),
    file,
    status,
    review,
  );
  file.onchange = async () => {
    try {
      const selected = file.files?.[0];
      if (!selected) return;
      if (selected.size > 134217728)
        throw new Error(
          "This browser workflow accepts files up to 128 MiB. Use the documented CLI workflow for larger installations.",
        );
      const text = await selected.text(),
        lines = text.trimEnd().split("\n"),
        manifest = JSON.parse(lines[0]),
        footer = JSON.parse(lines.at(-1)!);
      if (
        manifest.record_type !== "manifest" ||
        manifest.format !== "task-broker-portable" ||
        footer.record_type !== "checksums"
      )
        throw new Error("Expected a portable NDJSON manifest and checksum footer.");
      let offset = 1;
      const records: { record_type: string; data: unknown }[] = [];
      for (const chunk of footer.chunks) {
        const source = lines.slice(offset, offset + chunk.count);
        if ((await sha256(source.length ? source.join("\n") + "\n" : "")) !== chunk.sha256)
          throw new Error(`Checksum failed for ${chunk.table}.`);
        for (const line of source) {
          const value = JSON.parse(line);
          if (value.record_type !== chunk.table)
            throw new Error("Record type does not match checksum manifest.");
          records.push(value);
        }
        offset += chunk.count;
      }
      if (offset !== lines.length - 1 || records.length !== footer.total_records)
        throw new Error("Manifest record counts do not match the file.");
      const fingerprint = await sha256(text),
        storageKey = `task-broker:portable:${fingerprint}`;
      review.replaceChildren(
        el(
          "p",
          {},
          `${records.length.toLocaleString()} verified records. Source application ${manifest.app_version}; schema ${manifest.schema_version}.`,
        ),
        button(
          "Import verified records",
          async () => {
            let id = localStorage.getItem(storageKey),
              processed = 0;
            if (id) {
              const existing = await api(`/operations/${id}`);
              processed = existing.processed;
              if (existing.status === "complete") {
                status.textContent = "This file has already been imported.";
                return;
              }
            } else {
              const op = await api("/portable-import/preview", {
                ...operation(),
                manifest,
                total_records: records.length,
              });
              id = op.operation_id;
              localStorage.setItem(storageKey, id!);
            }
            while (processed < records.length && d.dialog.open) {
              const table = records[processed].record_type;
              let chunk = records.slice(processed, processed + 50);
              const boundary = chunk.findIndex((r) => r.record_type !== table);
              if (boundary >= 0) chunk = chunk.slice(0, boundary);
              while (
                new TextEncoder().encode(JSON.stringify(chunk)).length > 480000 &&
                chunk.length > 1
              )
                chunk = chunk.slice(0, Math.ceil(chunk.length / 2));
              await api(`/portable-import/${id}/chunks`, {
                ...operation(),
                table,
                rows: chunk.map((r) => r.data),
              });
              processed += chunk.length;
              status.textContent = `Imported ${processed.toLocaleString()} / ${records.length.toLocaleString()}`;
            }
            if (processed === records.length) {
              status.textContent =
                "Import complete. Review configuration, issue new family keys and test disposable work before enabling pools.";
              d.dialog.dataset.dirty = "";
            }
          },
          "danger",
        ),
      );
    } catch (error) {
      review.replaceChildren(errorBox(error));
    }
  };
}
