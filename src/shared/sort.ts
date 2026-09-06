import { z } from "zod";
import { assert, validate, type Field } from "./core";
import { integerCompare, sqlString, type ResolvedField } from "./filter";
import type { TaskRow } from "./contracts";

export const sortSchema = z
  .array(
    z
      .object({
        field: z.string().min(1).max(256),
        direction: z.enum(["asc", "desc"]),
      })
      .strict(),
  )
  .max(8)
  .describe(
    "Sort fields in priority order (at most eight distinct scalar keys or labels). Null/missing first in either direction; binary text, numeric Boolean/number and exact decimal-integer comparison. Internal UUID breaks final ties.",
  );
export type SortSpec = z.infer<typeof sortSchema>;
export type ResolvedSort = ResolvedField & { direction: "asc" | "desc" };
export const defaultSorts = (): SortSpec => [{ field: "task_id", direction: "asc" }];

/** Normalize legacy view aliases before header promotion or local comparison. */
export function sortKeys(spec: SortSpec, fields: Field[]): SortSpec {
  return spec.map((s) => {
    const name = s.field.toLowerCase();
    const field = fields.find(
      (f) => f.active && (f.key.toLowerCase() === name || f.label.toLowerCase() === name),
    );
    return { ...s, field: field?.key ?? name };
  });
}

export function sortChoice(value: {
  sorts?: SortSpec;
  sort?: string;
  direction?: string;
}): SortSpec {
  assert(
    value.sorts === undefined || (value.sort === undefined && value.direction === undefined),
    "INVALID_VALUE",
    "Use sorts or legacy sort/direction, not both.",
  );
  return (
    value.sorts ?? [
      { field: value.sort ?? "task_id", direction: value.direction === "desc" ? "desc" : "asc" },
    ]
  );
}

export function querySorts(params: URLSearchParams): SortSpec {
  let sorts: SortSpec | undefined;
  if (params.has("sorts")) {
    let raw: unknown;
    try {
      raw = JSON.parse(params.get("sorts")!);
    } catch {
      assert(false, "INVALID_VALUE", "sorts must be a JSON array.");
    }
    sorts = validate(sortSchema, raw);
  }
  return sortChoice({
    sorts,
    sort: params.get("sort") ?? undefined,
    direction: params.get("direction") ?? undefined,
  });
}

export function resolveSorts(
  spec: SortSpec,
  resolve: (key: string) => ResolvedField,
): ResolvedSort[] {
  const seen = new Set<string>();
  return validate(sortSchema, spec).map(({ field, direction }) => {
    const resolved = resolve(field);
    assert(
      resolved.type !== "json",
      "INVALID_VALUE",
      "Nested JSON cannot be sorted; map a scalar field instead.",
    );
    assert(!seen.has(resolved.key), "INVALID_VALUE", `Duplicate sort field: ${resolved.key}.`);
    seen.add(resolved.key);
    return { ...resolved, direction };
  });
}
export const sortSpec = (sorts: ResolvedSort[]): SortSpec =>
  sorts.map((s) => ({ field: s.key, direction: s.direction }));

/** Expressions are deliberately identical in SELECT and CREATE INDEX. */
export function scalarOrder(s: ResolvedSort): string {
  const e = s.expression,
    d = s.direction,
    reverse = d === "asc" ? "desc" : "asc";
  let value = `${e} COLLATE BINARY ${d}`;
  if (s.type === "integer") {
    const negative = `substr(CAST(${e} AS TEXT),1,1)='-'`,
      digits = `ltrim(CAST(${e} AS TEXT),'-')`;
    value = `(${negative}) ${reverse},(CASE WHEN ${negative} THEN -length(${digits}) ELSE length(${digits}) END) ${d},CASE WHEN ${negative} THEN ${digits} END ${reverse},CASE WHEN NOT(${negative}) THEN ${digits} END ${d}`;
  }
  return `(${e} IS NOT NULL) asc,${value}`;
}
export const sortOrder = (sorts: ResolvedSort[], uid = "t.task_uid") =>
  [...sorts.map(scalarOrder), uid].join(",");
export const sortProjection = (sorts: ResolvedSort[]) =>
  sorts.map((s, i) => `${s.expression} AS sort_${i}`).join(",");

export function sortAfter(sorts: ResolvedSort[], last: { values: unknown[]; uid: string }): string {
  assert(
    Array.isArray(last.values) &&
      last.values.length === sorts.length &&
      typeof last.uid === "string",
    "INVALID_VALUE",
    "Invalid sort cursor.",
  );
  let after = `t.task_uid>${sqlString(last.uid)}`;
  for (let i = sorts.length - 1; i >= 0; i--) {
    const s = sorts[i],
      e = s.expression,
      v = last.values[i];
    if (v === null) {
      after = `(${e} IS NOT NULL OR (${e} IS NULL AND (${after})))`;
      continue;
    }
    const numeric = s.type === "number" || s.type === "boolean";
    if (numeric)
      assert(Number.isFinite(Number(v)), "INVALID_VALUE", "Invalid numeric sort cursor.");
    const literal = numeric ? String(Number(v)) : sqlString(String(v));
    const comparison = s.type === "integer" ? integerCompare(e, literal) : null;
    const equal = comparison ? `${comparison}=0` : `${e}=${literal} COLLATE BINARY`;
    const greater = comparison
      ? `${comparison}${s.direction === "asc" ? ">" : "<"}0`
      : `${e}${s.direction === "asc" ? ">" : "<"}${literal} COLLATE BINARY`;
    after = `(${e} IS NOT NULL AND (${greater} OR (${equal} AND (${after}))))`;
  }
  return after;
}

export function promoteSort(spec: SortSpec, field: string): SortSpec {
  const old = spec.find((s) => s.field === field);
  assert(
    old || spec.length < 8,
    "INVALID_VALUE",
    "Up to eight sort fields are supported. Remove a sort field first.",
  );
  const direction =
    spec[0]?.field === field
      ? old!.direction === "asc"
        ? "desc"
        : "asc"
      : (old?.direction ?? "asc");
  return [{ field, direction }, ...spec.filter((s) => s.field !== field)];
}

const encoder = new TextEncoder();
function binaryCompare(a: string, b: string): number {
  if (a === b) return 0;
  const x = encoder.encode(a),
    y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
export function taskComparator(
  spec: SortSpec,
  fields: Field[],
): (a: TaskRow, b: TaskRow) => number {
  const columns = sortKeys(spec, fields).map((s) => {
    const field = fields.find((f) => f.active && f.key === s.field);
    const type =
      field?.type ??
      (["attempts", "attempts_total"].includes(s.field)
        ? "integer"
        : s.field === "enabled"
          ? "boolean"
          : "string");
    return {
      ...s,
      type,
      read: (r: TaskRow): any =>
        field ? (field.kind === "input" ? r.data : r.result)?.[field.key] : (r as any)[s.field],
    };
  });
  return (a, b) => {
    for (const s of columns) {
      const x = s.read(a),
        y = s.read(b);
      if (x == null || y == null) {
        if (x != null) return 1;
        if (y != null) return -1;
        continue;
      }
      const cmp =
        s.type === "integer"
          ? BigInt(x) < BigInt(y)
            ? -1
            : BigInt(x) > BigInt(y)
              ? 1
              : 0
          : s.type === "number" || s.type === "boolean"
            ? Number(x) - Number(y)
            : binaryCompare(String(x), String(y));
      if (cmp) return s.direction === "asc" ? cmp : -cmp;
    }
    return binaryCompare(a.task_uid, b.task_uid);
  };
}
