import { assert, iso } from "../shared/core";
import { actorId, all } from "./db";
import { decodeCursor, encodeCursor } from "./pagination";
import type { Context, Row } from "./types";

const definitions = {
  families: { table: "families", id: "id", order: "name", search: "name", descending: false },
  pools: { table: "pools", id: "id", order: "name", search: "name", descending: false },
  profiles: { table: "profiles", id: "id", order: "name", search: "name", descending: false },
  keys: { table: "api_keys", id: "id", order: "issued_at", search: "label", descending: true },
  views: { table: "saved_views", id: "id", order: "name", search: "name", descending: false },
  administrators: {
    table: "administrators",
    id: "subject",
    order: "email",
    search: "email",
    descending: false,
  },
  operations: {
    table: "admin_operations",
    id: "id",
    order: "created_at",
    search: "kind",
    descending: true,
  },
  audit: {
    table: "audit_events",
    id: "id",
    order: "timestamp",
    search: "entity_type",
    descending: true,
  },
  warnings: {
    table: "warnings",
    id: "id",
    order: "last_seen",
    search: "message",
    descending: true,
  },
} as const;
export type Collection = keyof typeof definitions;
export const isCollection = (name: string): name is Collection => Object.hasOwn(definitions, name);

export async function listCollection(c: Context, name: Collection) {
  const d = definitions[name],
    params: unknown[] = [],
    where: string[] = [];
  if (name === "views") {
    where.push("(shared=1 OR owner=?)");
    params.push(c.actor.id);
  }
  if (name === "operations") {
    where.push("actor=?");
    params.push(actorId(c.actor));
  }
  const filters: Record<string, string> = {};
  for (const key of ["pool_id", "family_id", "profile_id", "kind", "filter"]) {
    const value = c.url.searchParams.get(key);
    if (!value) continue;
    let column: string | undefined;
    if (key === "filter") {
      where.push(`instr(${d.search},?)>0`);
      params.push(value);
      filters[key] = value;
      continue;
    }
    if (key === "pool_id" && ["profiles", "views", "operations"].includes(name)) column = "pool_id";
    if (key === "family_id" && ["profiles", "keys"].includes(name)) column = "family_id";
    if (key === "family_id" && name === "pools") column = "owner_family_id";
    if (key === "family_id" && name === "families") column = "id";
    if (key === "profile_id" && ["views", "operations"].includes(name)) column = "profile_id";
    if (key === "kind" && name === "operations") column = "kind";
    assert(column, "INVALID_VALUE", `${key} is not a filter for ${name}.`);
    where.push(`${column}=?`);
    params.push(value);
    filters[key] = value;
  }
  const limit = Number(c.url.searchParams.get("limit") ?? 100),
    offset = Number(c.url.searchParams.get("offset") ?? 0);
  const sort = c.url.searchParams.get("sort") ?? d.order;
  assert(
    [d.id, d.order, d.search].includes(sort as never),
    "INVALID_VALUE",
    `Unsupported sort for ${name}.`,
  );
  const direction = c.url.searchParams.get("direction") ?? (d.descending ? "desc" : "asc"),
    scope = { collection: name, actor: actorId(c.actor), filters, direction, sort, limit };
  const cursor = c.url.searchParams.get("cursor"),
    last = cursor ? await decodeCursor(c.env, cursor, scope) : null;
  assert(!last || offset === 0, "INVALID_VALUE", "Use either an offset or a cursor.");
  if (last) {
    where.push(`(${sort} ${direction === "desc" ? "<" : ">"} ? OR (${sort}=? AND ${d.id}>?))`);
    params.push(last.value, last.value, last.id);
  }
  const columns =
    name === "keys"
      ? "id,family_id,label,prefix,status,issued_at,revoked_at,last_used_at"
      : name === "operations"
        ? "id,kind,pool_id,profile_id,status,created_at,expires_at,total,processed"
        : "*";
  const rows = await all(
    c.env.DB,
    `SELECT ${columns} FROM ${d.table} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${sort} COLLATE BINARY ${direction},${d.id} COLLATE BINARY ASC LIMIT ? OFFSET ?`,
    ...params,
    limit + 1,
    offset,
  );
  const page = rows.slice(0, limit),
    tail = page.at(-1);
  const requested = c.url.searchParams
    .get("fields")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const converted = page.map((row) => {
    const out: Row = { ...row };
    if (name === "views") {
      out.presentation = JSON.parse(out.presentation_json);
      delete out.presentation_json;
    }
    for (const key of Object.keys(out))
      if (
        (key.endsWith("_at") || ["timestamp", "first_seen", "last_seen"].includes(key)) &&
        typeof out[key] === "number"
      )
        out[key] = iso(out[key]);
    if (requested) {
      for (const field of requested)
        assert(Object.hasOwn(out, field), "INVALID_VALUE", `Unknown selected field ${field}.`);
      return Object.fromEntries(
        Object.entries(out).filter(([k]) => k === d.id || requested.includes(k)),
      );
    }
    return out;
  });
  return {
    rows: converted,
    cursor:
      rows.length > limit
        ? await encodeCursor(c.env, scope, { value: tail![sort], id: tail![d.id] })
        : null,
  };
}
