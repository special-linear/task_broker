import { AppError, assert, bytes, LIMITS, type Field } from "./core";
export type Literal = {
  kind: "string" | "number" | "boolean" | "datetime";
  value: string | number | boolean;
};
export type Ast =
  | { kind: "and"; left: Ast; right: Ast }
  | { kind: "or"; left: Ast; right: Ast }
  | { kind: "not"; child: Ast }
  | { kind: "tag"; value: string; negated: boolean }
  | { kind: "test"; field: string; op: string; values: Literal[] };
type Token = {
  kind: "name" | "string" | "number" | "op" | "end";
  value: string;
  at: number;
};
function tokenize(text: string): Token[] {
  assert(bytes(text) <= LIMITS.filterBytes, "FILTER_TOO_COMPLEX", "Filters are limited to 4 KiB.");
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    if (/\s/.test(text[at])) {
      at++;
      continue;
    }
    const start = at,
      c = text[at];
    if (c === '"') {
      at++;
      let escaped = false;
      while (at < text.length) {
        const x = text[at++];
        if (!escaped && x === '"') break;
        if (!escaped && x === "\\") escaped = true;
        else escaped = false;
      }
      try {
        tokens.push({
          kind: "string",
          value: JSON.parse(text.slice(start, at)),
          at: start,
        });
      } catch {
        throw new AppError("INVALID_FILTER", `Invalid string at character ${start + 1}.`);
      }
      continue;
    }
    if (c === "`") {
      at++;
      const end = text.indexOf("`", at);
      assert(end >= 0, "INVALID_FILTER", "Unclosed field name.");
      tokens.push({ kind: "name", value: text.slice(at, end), at: start });
      at = end + 1;
      continue;
    }
    const number = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(at));
    if (number) {
      tokens.push({ kind: "number", value: number[0], at });
      at += number[0].length;
      continue;
    }
    const op = /^(?:!=|<=|>=|[=<>(),:])/.exec(text.slice(at));
    if (op) {
      tokens.push({ kind: "op", value: op[0], at });
      at += op[0].length;
      continue;
    }
    const name = /^[\p{L}_][\p{L}\p{N}_\-.]*/u.exec(text.slice(at));
    assert(name, "INVALID_FILTER", `Unexpected character at ${at + 1}.`);
    tokens.push({ kind: "name", value: name[0], at });
    at += name[0].length;
  }
  return [...tokens, { kind: "end", value: "", at }];
}
export function parseFilter(text: string): Ast | null {
  if (!text.trim()) return null;
  const ts = tokenize(text);
  let index = 0,
    nodes = 0;
  const peek = () => ts[index];
  const take = (s: string) => (peek().value.toUpperCase() === s ? (index++, true) : false);
  const expect = (s: string) =>
    assert(take(s), "INVALID_FILTER", `Expected ${s} at character ${peek().at + 1}.`);
  const node = <T extends Ast>(v: T): T => {
    assert(
      ++nodes <= LIMITS.filterNodes,
      "FILTER_TOO_COMPLEX",
      "Use at most 100 expression nodes.",
    );
    return v;
  };
  const literal = (): Literal => {
    const t = ts[index++];
    if (t.kind === "string") return { kind: "string", value: t.value };
    if (t.kind === "number") {
      if (/^-?\d+$/.test(t.value)) {
        const n = BigInt(t.value);
        return {
          kind: "number",
          value:
            n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(n)
              : n.toString(),
        };
      }
      const n = Number(t.value);
      assert(
        Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n)),
        "INVALID_FILTER",
        "Use full decimal digits for large integer filter literals; exponent or fraction notation must fit the exact numeric range.",
      );
      return { kind: "number", value: n };
    }
    if (t.kind === "name" && ["TRUE", "FALSE"].includes(t.value.toUpperCase()))
      return { kind: "boolean", value: t.value.toUpperCase() === "TRUE" };
    if (t.kind === "name" && t.value.toUpperCase() === "DATETIME") {
      expect("(");
      const v = ts[index++];
      assert(
        v.kind === "string" &&
          /^\d{4}-\d\d-\d\dT/.test(v.value) &&
          Number.isFinite(Date.parse(v.value)),
        "INVALID_FILTER",
        "datetime() requires an RFC 3339 string.",
      );
      expect(")");
      return { kind: "datetime", value: new Date(v.value).toISOString() };
    }
    throw new AppError("INVALID_FILTER", `Expected a typed literal at character ${t.at + 1}.`);
  };
  const primary = (depth: number): Ast => {
    assert(depth <= LIMITS.filterDepth, "FILTER_TOO_COMPLEX", "Filter nesting exceeds 10 levels.");
    if (take("NOT")) return node({ kind: "not", child: primary(depth + 1) });
    if (take("(")) {
      const v = or(depth + 1);
      expect(")");
      return v;
    }
    const f = ts[index++];
    assert(f.kind === "name", "INVALID_FILTER", `Expected a field at character ${f.at + 1}.`);
    if (["HAS", "HAS_NOT"].includes(f.value.toUpperCase()) && take(":")) {
      const t = ts[index++];
      assert(
        t.kind === "name" || t.kind === "string" || t.kind === "number",
        "INVALID_FILTER",
        "Expected a tag.",
      );
      return node({
        kind: "tag",
        value: t.value.trim().normalize("NFC").toLowerCase(),
        negated: f.value.toUpperCase() === "HAS_NOT",
      });
    }
    if (take("IS")) {
      const not = take("NOT");
      expect("BLANK");
      return node({
        kind: "test",
        field: f.value,
        op: not ? "IS NOT BLANK" : "IS BLANK",
        values: [],
      });
    }
    const not = take("NOT");
    if (take("IN")) {
      expect("(");
      const values = [literal()];
      while (take(",")) values.push(literal());
      expect(")");
      assert(values.length <= 50, "FILTER_TOO_COMPLEX", "IN supports at most 50 literals.");
      return node({
        kind: "test",
        field: f.value,
        op: not ? "NOT IN" : "IN",
        values,
      });
    }
    assert(!not, "INVALID_FILTER", "NOT after a field must be followed by IN.");
    const op = ts[index++].value.toUpperCase();
    assert(
      ["=", "!=", "<", "<=", ">", ">=", "CONTAINS", "STARTS_WITH"].includes(op),
      "INVALID_FILTER",
      `Unsupported comparison ${op}.`,
    );
    return node({ kind: "test", field: f.value, op, values: [literal()] });
  };
  const and = (depth: number): Ast => {
    let a = primary(depth);
    while (take("AND")) a = node({ kind: "and", left: a, right: primary(depth) });
    return a;
  };
  const or = (depth: number): Ast => {
    let a = and(depth);
    while (take("OR")) a = node({ kind: "or", left: a, right: and(depth) });
    return a;
  };
  const ast = or(0);
  assert(
    peek().kind === "end",
    "INVALID_FILTER",
    `Unexpected token at ${peek().at + 1}; comparison chains are not supported.`,
  );
  return ast;
}
export type ResolvedField = {
  key: string;
  type: Field["type"];
  expression: string;
};
export function fieldResolver(
  fields: Field[],
  system: Record<string, ResolvedField>,
  allowlist?: string[],
) {
  return (name: string): ResolvedField => {
    const lower = name.toLowerCase();
    const f = fields.find(
      (f) => f.active && (f.key.toLowerCase() === lower || f.label.toLowerCase() === lower),
    );
    const resolved = f
      ? {
          key: f.key,
          type: f.type,
          expression: `(SELECT value FROM json_each(${f.kind === "result" ? "t.result_summary_json" : "t.parameters_json"}) WHERE key=${sqlString(f.key)})`,
        }
      : system[lower];
    assert(resolved, "UNKNOWN_FIELD", `Unknown field: ${name}`);
    assert(
      !allowlist || allowlist.some((k) => k.toLowerCase() === resolved.key.toLowerCase()),
      "FORBIDDEN",
      `Filtering by ${name} is not allowed for this profile.`,
      403,
    );
    return resolved;
  };
}
export const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
function validateTest(a: Extract<Ast, { kind: "test" }>, f: ResolvedField) {
  if (a.op.startsWith("IS ")) return;
  assert(f.type !== "json", "INVALID_FILTER", `${f.key} supports only blank tests.`);
  if (["CONTAINS", "STARTS_WITH"].includes(a.op))
    assert(f.type === "string", "INVALID_FILTER", "Text operators require a string field.");
  for (const l of a.values) {
    const expected = f.type === "integer" ? "number" : f.type;
    assert(
      l.kind === expected,
      "INVALID_FILTER",
      `The literal for ${f.key} must have type ${f.type}.`,
    );
    if (f.type === "integer")
      assert(
        typeof l.value === "string" || Number.isInteger(l.value),
        "INVALID_FILTER",
        `${f.key} requires an integer literal.`,
      );
  }
}
// Compare normalized decimal integers without SQLite REAL conversion or int64 overflow.
export function integerCompare(a: string, b: string): string {
  const x = `CAST(${a} AS TEXT)`,
    y = `CAST(${b} AS TEXT)`;
  const ax = `ltrim(${x},'-')`,
    ay = `ltrim(${y},'-')`;
  return `(CASE WHEN substr(${x},1,1)='-' AND substr(${y},1,1)!='-' THEN -1 WHEN substr(${x},1,1)!='-' AND substr(${y},1,1)='-' THEN 1 ELSE (CASE WHEN length(${ax})<length(${ay}) THEN -1 WHEN length(${ax})>length(${ay}) THEN 1 WHEN ${ax}<${ay} COLLATE BINARY THEN -1 WHEN ${ax}>${ay} COLLATE BINARY THEN 1 ELSE 0 END)*(CASE WHEN substr(${x},1,1)='-' THEN -1 ELSE 1 END) END)`;
}
export function compileFilter(
  ast: Ast | null,
  resolve: (name: string) => ResolvedField,
  start = 1,
): { sql: string; params: (string | number | null)[] } {
  const params: (string | number | null)[] = [];
  const bind = (v: unknown) => {
    params.push(typeof v === "boolean" ? Number(v) : (v as string | number | null));
    return `?${start + params.length - 1}`;
  };
  const visit = (a: Ast): string => {
    if (a.kind === "and" || a.kind === "or")
      return `(${visit(a.left)} ${a.kind.toUpperCase()} ${visit(a.right)})`;
    if (a.kind === "not") return `(NOT ${visit(a.child)})`;
    if (a.kind === "tag")
      return `${a.negated ? "NOT " : ""}EXISTS(SELECT 1 FROM task_tags ft WHERE ft.task_uid=t.task_uid AND ft.tag=${bind(a.value)})`;
    const f = resolve(a.field);
    validateTest(a, f);
    const e = f.expression,
      blank = `(${e} IS NULL OR ${e}='')`;
    if (a.op === "IS BLANK") return blank;
    if (a.op === "IS NOT BLANK") return `(NOT ${blank})`;
    let predicate: string;
    if (a.op === "IN" || a.op === "NOT IN") {
      const values = bind(JSON.stringify(a.values.map((x) => x.value)));
      const cmp =
        f.type === "integer"
          ? `${integerCompare(e, "fv.value")}=0`
          : `${e}=fv.value COLLATE BINARY`;
      predicate = `${a.op === "NOT IN" ? "NOT " : ""}EXISTS(SELECT 1 FROM json_each(${values}) fv WHERE ${cmp})`;
    } else {
      const v = bind(f.type === "integer" ? String(a.values[0].value) : a.values[0].value);
      if (a.op === "CONTAINS") predicate = `instr(${e},${v})>0`;
      else if (a.op === "STARTS_WITH")
        predicate = `substr(${e},1,length(${v}))=${v} COLLATE BINARY`;
      else
        predicate =
          f.type === "integer"
            ? `${integerCompare(e, v)} ${a.op} 0`
            : `${e} ${a.op} ${v} COLLATE BINARY`;
    }
    return `(CASE WHEN ${blank} THEN 0 ELSE (${predicate}) END)`;
  };
  const sql = ast ? visit(ast) : "1";
  assert(
    params.length + start - 1 <= 100 && bytes(sql) < 95000,
    "FILTER_TOO_COMPLEX",
    "Filter exceeds the database query budget.",
  );
  return { sql, params };
}
export function evaluateFilter(
  ast: Ast | null,
  row: Record<string, unknown>,
  resolve: (name: string) => ResolvedField,
  tags: string[] = [],
): boolean {
  if (!ast) return true;
  if (ast.kind === "and")
    return (
      evaluateFilter(ast.left, row, resolve, tags) && evaluateFilter(ast.right, row, resolve, tags)
    );
  if (ast.kind === "or")
    return (
      evaluateFilter(ast.left, row, resolve, tags) || evaluateFilter(ast.right, row, resolve, tags)
    );
  if (ast.kind === "not") return !evaluateFilter(ast.child, row, resolve, tags);
  if (ast.kind === "tag") return tags.includes(ast.value) !== ast.negated;
  const f = resolve(ast.field);
  validateTest(ast, f);
  const v = row[f.key],
    blank = v === null || v === undefined || v === "";
  if (ast.op === "IS BLANK") return blank;
  if (ast.op === "IS NOT BLANK") return !blank;
  if (blank) return false;
  const compare = (l: Literal) => {
    const a =
        f.type === "integer" ? BigInt(v as string | number) : (v as string | number | boolean),
      b = f.type === "integer" ? BigInt(l.value as string | number) : l.value;
    return a === b ? 0 : a < b ? -1 : 1;
  };
  switch (ast.op) {
    case "=":
      return compare(ast.values[0]) === 0;
    case "!=":
      return compare(ast.values[0]) !== 0;
    case "<":
      return compare(ast.values[0]) < 0;
    case "<=":
      return compare(ast.values[0]) <= 0;
    case ">":
      return compare(ast.values[0]) > 0;
    case ">=":
      return compare(ast.values[0]) >= 0;
    case "IN":
      return ast.values.some((l) => compare(l) === 0);
    case "NOT IN":
      return !ast.values.some((l) => compare(l) === 0);
    case "CONTAINS":
      return String(v).includes(String(ast.values[0].value));
    case "STARTS_WITH":
      return String(v).startsWith(String(ast.values[0].value));
    default:
      return false;
  }
}
export function formatFilter(ast: Ast | null): string {
  if (!ast) return "";
  if (ast.kind === "and" || ast.kind === "or")
    return `(${formatFilter(ast.left)} ${ast.kind.toUpperCase()} ${formatFilter(ast.right)})`;
  if (ast.kind === "not") return `NOT (${formatFilter(ast.child)})`;
  if (ast.kind === "tag") return `${ast.negated ? "has_not" : "has"}:${JSON.stringify(ast.value)}`;
  const values = ast.values.map((v) =>
    v.kind === "datetime"
      ? `datetime(${JSON.stringify(v.value)})`
      : v.kind === "string"
        ? JSON.stringify(v.value)
        : String(v.value),
  );
  return `\`${ast.field}\` ${ast.op}${ast.op.startsWith("IS ") ? "" : ast.op.endsWith("IN") ? ` (${values.join(", ")})` : ` ${values[0]}`}`;
}
