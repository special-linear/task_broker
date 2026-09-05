import {
  TabulatorFull as Tabulator,
  type CellComponent,
  type ColumnDefinition,
} from "tabulator-tables";
import { parseJSON, type Field } from "../shared/core";
import type { TaskRow } from "../shared/contracts";
import { dialog, el, button } from "./dom";
export function inputValue(
  text: unknown,
  field: Pick<Field, "type" | "nullable" | "label">,
): unknown {
  if (field.type === "string") return String(text ?? "");
  if (text === "" || text === null) return field.nullable ? null : "";
  if (field.type === "integer") {
    const s = String(text).trim();
    if (!/^-?\d+$/.test(s)) throw new Error(`${field.label} requires an integer.`);
    const n = BigInt(s);
    return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(n)
      : n.toString();
  }
  if (field.type === "number") {
    const n = Number(text);
    if (!Number.isFinite(n)) throw new Error(`${field.label} requires a finite number.`);
    return n;
  }
  if (field.type === "boolean") {
    if (typeof text === "boolean") return text;
    const s = String(text).trim().toLowerCase();
    if (["true", "1"].includes(s)) return true;
    if (["false", "0"].includes(s)) return false;
    throw new Error(`${field.label} requires true/false or 1/0.`);
  }
  if (field.type === "datetime") {
    const s = String(text);
    if (!/T/.test(s) || !Number.isFinite(Date.parse(s)))
      throw new Error(`${field.label} requires an ISO datetime.`);
    return new Date(s).toISOString();
  }
  return typeof text === "string" ? parseJSON(text) : text;
}
export class TaskGrid {
  table: Tabulator;
  readonly ready: Promise<void>;
  editing = false;
  editingId: string | null = null;
  private suppress = false;
  private pasteCell: CellComponent | null = null;
  constructor(
    container: HTMLElement,
    fields: Field[],
    rows: TaskRow[],
    private onEdit: (row: TaskRow, key: string, value: unknown) => void,
    onDetails: (row: TaskRow) => void,
    onSelect: (count: number) => void,
    onSort: (key: string) => void,
    onPaste: (text: string, rows: TaskRow[], columns: string[]) => Promise<void>,
  ) {
    const col = (
      title: string,
      field: string,
      extra: Partial<ColumnDefinition> = {},
    ): ColumnDefinition => ({
      title,
      titleFormatter: () => el("span", {}, title),
      field,
      formatter: "plaintext",
      minWidth: 100,
      headerSort: false,
      headerClick: () => onSort(field.replace(/^input:/, "")),
      ...extra,
    });
    const columns: ColumnDefinition[] = [
      {
        title: "",
        formatter: "rowSelection",
        titleFormatter: "rowSelection",
        headerSort: false,
        hozAlign: "center",
        width: 42,
        cellClick: (_e, cell) => cell.getRow().toggleSelect(),
      },
      col("Task ID", "task_id", { frozen: true, minWidth: 150 }),
      col("Enabled", "enabled", {
        editor: "tickCross",
        formatter: "tickCross",
        width: 90,
      }),
    ];
    for (const f of fields.filter((f) => f.kind === "input" && f.active))
      columns.push(
        col(f.label, `input:${f.key}`, {
          editor:
            f.type === "boolean"
              ? "tickCross"
              : f.type === "json"
                ? undefined
                : f.type === "string"
                  ? "textarea"
                  : "input",
          formatter:
            f.type === "boolean"
              ? "tickCross"
              : (cell) => {
                  const span = el(
                    "span",
                    {},
                    typeof cell.getValue() === "object"
                      ? JSON.stringify(cell.getValue())
                      : String(cell.getValue() ?? ""),
                  );
                  return span;
                },
          cellDblClick: f.type === "json" ? (_e, cell) => this.jsonEdit(cell, f) : undefined,
          minWidth: 140,
        }),
      );
    columns.push(
      col("Tags", "tags_text", { editor: "input", minWidth: 140 }),
      col("Status", "status", { width: 110 }),
      col("Attempts", "attempts", { width: 95 }),
      col("Lease expiry", "expires_at", { minWidth: 190 }),
    );
    for (const f of fields.filter((f) => f.kind === "result" && f.active))
      columns.push(col(f.label, `result:${f.key}`, { minWidth: 120 }));
    columns.push(col("Admin note", "admin_note", { editor: "textarea", minWidth: 180 }), {
      title: "Details",
      headerSort: false,
      formatter: () => el("span", {}, "Open →"),
      cellClick: (_e, cell) => onDetails((cell.getRow().getData() as any).__row),
      width: 95,
    });
    this.table = new Tabulator(container, {
      height: "min(65vh, 700px)",
      layout: "fitDataStretch",
      index: "task_uid",
      nestedFieldSeparator: false,
      movableColumns: true,
      selectableRows: true,
      columns,
      data: rows.map((r) => this.flatten(r, fields)),
      placeholder: "No tasks match this view.",
      clipboard: "copy",
      clipboardCopyRowRange: "selected",
      editTriggerEvent: "dblclick",
    });
    this.ready = new Promise((resolve) => this.table.on("tableBuilt", resolve));
    container.tabIndex = 0;
    this.table.on("cellClick", (_event: Event, cell: CellComponent) => {
      this.pasteCell = cell;
    });
    container.addEventListener(
      "paste",
      (event) => {
        if (this.editing || !this.pasteCell) return;
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const rows = this.table.getRows("active"),
          index = rows.findIndex((r) => r === this.pasteCell!.getRow()),
          columns = this.table
            .getColumns()
            .filter((c) => c.isVisible())
            .map((c) => c.getField()),
          start = columns.indexOf(this.pasteCell.getField());
        if (index >= 0 && start >= 0)
          void onPaste(
            text,
            rows.slice(index).map((r) => r.getData().__row),
            columns.slice(start),
          ).catch((error) => {
            const d = dialog("Paste not staged");
            d.content.append(el("p", {}, error instanceof Error ? error.message : String(error)));
          });
      },
      true,
    );
    this.table.on("cellEditing", (cell: CellComponent) => {
      this.editing = true;
      this.editingId = cell.getRow().getData().task_uid;
    });
    this.table.on("cellEditCancelled", () => {
      this.editing = false;
      this.editingId = null;
    });
    this.table.on("cellEdited", (cell: CellComponent) => {
      this.editing = false;
      this.editingId = null;
      if (this.suppress) return;
      const row = cell.getRow().getData() as any;
      try {
        const key = cell.getField();
        let value = cell.getValue();
        if (key.startsWith("input:"))
          value = inputValue(
            value,
            fields.find((f) => f.key === key.slice(6))!,
          );
        this.onEdit(row.__row, key, value);
      } catch (error) {
        cell.getElement().classList.add("cell-error");
        this.onEdit(row.__row, cell.getField(), cell.getValue());
      }
    });
    this.table.on("rowSelectionChanged", (data) => onSelect(data.length));
  }
  private flatten(r: TaskRow, fields: Field[]) {
    return {
      ...r,
      __row: r,
      tags_text: r.tags.join(", "),
      ...Object.fromEntries(
        fields.map((f) => [
          `${f.kind}:${f.key}`,
          f.kind === "input" ? r.data[f.key] : r.result?.[f.key],
        ]),
      ),
    };
  }
  async update(row: TaskRow, fields: Field[]) {
    this.suppress = true;
    try {
      await this.table.updateData([this.flatten(row, fields)]);
    } finally {
      this.suppress = false;
    }
  }
  async updateRows(rows: TaskRow[], fields: Field[]) {
    this.suppress = true;
    try {
      await this.table.updateData(rows.map((r) => this.flatten(r, fields)));
    } finally {
      this.suppress = false;
    }
  }
  selected(): TaskRow[] {
    return this.table.getSelectedData().map((x: any) => x.__row);
  }
  columns() {
    return this.table
      .getColumns()
      .filter((c) => c.getField())
      .map((c) => ({
        field: c.getField(),
        width: c.getWidth(),
        visible: c.isVisible(),
      }));
  }
  applyColumns(columns: { field: string; width?: number; visible?: boolean }[]) {
    for (const c of columns) {
      const col = this.table.getColumn(c.field);
      if (col) {
        if (c.width) col.setWidth(c.width);
        if (c.visible === false) col.hide();
        else col.show();
      }
    }
    for (let i = 1; i < columns.length; i++)
      if (this.table.getColumn(columns[i].field) && this.table.getColumn(columns[i - 1].field))
        this.table.moveColumn(columns[i].field, columns[i - 1].field, true);
  }
  destroy() {
    this.table.destroy();
  }
  private jsonEdit(cell: CellComponent, f: Field) {
    const d = dialog(`Edit ${f.label}`),
      input = el("textarea", {
        value: JSON.stringify(cell.getValue() ?? {}, null, 2),
        rows: 15,
        style: "width:100%",
      });
    d.content.append(
      input,
      button(
        "Save",
        () => {
          try {
            const value = parseJSON(input.value);
            cell.setValue(value);
            d.dialog.close();
          } catch {
            input.setCustomValidity("Enter valid JSON.");
            input.reportValidity();
          }
        },
        "primary",
      ),
    );
  }
}
