import { parse, isLosslessNumber } from "lossless-json";
import { z } from "zod";

export const VERSION = "0.1.0";
export const LIMITS = Object.freeze({
  claim: 20,
  items: 20,
  inputBytes: 32768,
  resultBytes: 16384,
  bodyBytes: 524288,
  responseBytes: 1048576,
  rows: 100,
  page: 250,
  depth: 20,
  filterBytes: 4096,
  filterNodes: 100,
  filterDepth: 10,
  inItems: 50,
});
export const DEFAULTS = Object.freeze({
  lease_seconds: 7200,
  max_lifetime_seconds: 86400,
  claim_cap: 20,
  worker_profile_cap: 20,
  profile_cap: 100,
  family_cap: null as number | null,
  worker_family_cap: null as number | null,
  max_attempts: 10 as number | null,
});
export type Policy = typeof DEFAULTS;
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
    public details: unknown = undefined,
    public retryable = false,
  ) {
    super(message);
  }
}
export function assert(
  value: unknown,
  code: string,
  message: string,
  status = 422,
  details?: unknown,
): asserts value {
  if (!value) throw new AppError(code, message, status, details);
}
export const json = (value: unknown) => JSON.stringify(value);
export const bytes = (value: string) => new TextEncoder().encode(value).length;
export const nowIso = () => new Date().toISOString();
export const iso = (value: number | null | undefined) =>
  value == null ? null : new Date(value).toISOString();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${json(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  assert(
    value !== undefined && (typeof value !== "number" || Number.isFinite(value)),
    "INVALID_VALUE",
    "JSON values must be finite and defined.",
  );
  return json(value);
}
export async function sha256(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function randomSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function parseJSON(text: string): unknown {
  const convert = (v: unknown, depth = 0): unknown => {
    assert(depth <= LIMITS.depth, "INVALID_VALUE", "JSON nesting exceeds 20 levels.");
    if (isLosslessNumber(v)) {
      const n = Number(v.value);
      assert(
        Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n)),
        "INVALID_VALUE",
        "Integers outside the exact JavaScript range must be quoted decimal strings.",
      );
      return n;
    }
    if (Array.isArray(v)) return v.map((x) => convert(x, depth + 1));
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convert(x, depth + 1)]));
    return v;
  };
  try {
    return convert(parse(text));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("BAD_REQUEST", "Invalid JSON.", 400);
  }
}
export function normalizeTags(value: unknown): string[] {
  assert(
    Array.isArray(value) && value.every((x) => typeof x === "string"),
    "INVALID_VALUE",
    "Tags must be an array of strings.",
  );
  const tags = value.map((x: string) => x.trim().normalize("NFC").toLowerCase()).filter(Boolean);
  assert(
    tags.every((x) => !x.includes(",")),
    "INVALID_VALUE",
    "A tag cannot contain a comma.",
  );
  return [...new Set(tags)].sort();
}
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "Control characters are not allowed");
export const slugSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  .transform((s) => s.toLowerCase());
const cap = z.number().int().min(0).nullable().optional();
export const policySchema = z
  .object({
    lease_seconds: z.number().int().positive().optional(),
    max_lifetime_seconds: z.number().int().positive().optional(),
    claim_cap: z.number().int().min(0).max(20).optional(),
    worker_profile_cap: cap,
    profile_cap: cap,
    family_cap: cap,
    worker_family_cap: cap,
    max_attempts: cap,
  })
  .strict();
export const fieldSchema = z
  .object({
    id: z.string().uuid().optional(),
    key: idSchema,
    label: idSchema,
    type: z.enum(["string", "integer", "number", "boolean", "datetime", "json"]),
    kind: z.enum(["input", "result"]).default("input"),
    required: z.boolean().default(false),
    nullable: z.boolean().default(true),
    default: z.unknown().optional(),
    pointer: z.string().optional(),
    position: z.number().int().min(0).default(0),
    active: z.boolean().default(true),
  })
  .strict();
export type Field = z.infer<typeof fieldSchema>;
const reserved = new Set([
  "task_id",
  "status",
  "status_total",
  "attempts",
  "attempts_total",
  "tags",
  "enabled",
  "admin_note",
  "lease_expiry",
]);
export function validateFields(fields: Field[]) {
  const keys = new Set<string>(),
    names = new Map<string, string>();
  for (const f of fields) {
    const k = f.key.toLowerCase();
    assert(
      !reserved.has(k) && !keys.has(k),
      "INVALID_VALUE",
      `Reserved or duplicate field key: ${f.key}`,
    );
    keys.add(k);
    for (const name of [k, f.label.toLowerCase()]) {
      assert(
        !names.has(name) || names.get(name) === k,
        "INVALID_VALUE",
        `Ambiguous field label: ${f.label}`,
      );
      names.set(name, k);
    }
    if (f.kind === "result")
      assert(
        f.pointer !== undefined &&
          (f.pointer === "" || (f.pointer.startsWith("/") && !/~(?![01])/.test(f.pointer))),
        "INVALID_VALUE",
        `Invalid JSON Pointer for ${f.label}.`,
      );
    if (f.default !== undefined) normalizeValue(f.default, f);
  }
}
export function normalizeValue(v: unknown, f: Pick<Field, "type" | "nullable" | "label">): unknown {
  if (v === null) {
    assert(f.nullable, "INVALID_VALUE", `${f.label} cannot be null.`);
    return null;
  }
  switch (f.type) {
    case "string":
      assert(typeof v === "string", "INVALID_VALUE", `${f.label} must be text.`);
      return v;
    case "integer": {
      if (typeof v === "number") {
        assert(
          Number.isSafeInteger(v),
          "INVALID_VALUE",
          `${f.label} requires a safe integer or a decimal string.`,
        );
        return v;
      }
      assert(
        typeof v === "string" && /^-?\d+$/.test(v),
        "INVALID_VALUE",
        `${f.label} requires an integer.`,
      );
      const n = BigInt(v);
      return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(n)
        : n.toString();
    }
    case "number":
      assert(
        typeof v === "number" && Number.isFinite(v),
        "INVALID_VALUE",
        `${f.label} must be a finite number.`,
      );
      return v;
    case "boolean":
      assert(typeof v === "boolean", "INVALID_VALUE", `${f.label} must be true or false.`);
      return v;
    case "datetime":
      assert(
        typeof v === "string" &&
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) &&
          Number.isFinite(Date.parse(v)),
        "INVALID_VALUE",
        `${f.label} must be an RFC 3339 datetime.`,
      );
      return new Date(v).toISOString();
    case "json":
      assert(
        v !== null && typeof v === "object",
        "INVALID_VALUE",
        `${f.label} must be an object or array.`,
      );
      parseJSON(json(v));
      return v;
  }
}
export function normalizeInput(
  data: Record<string, unknown>,
  fields: Field[],
  creation = false,
): Record<string, unknown> {
  const inputs = fields.filter((f) => f.kind === "input" && f.active);
  const allowed = new Set(inputs.map((f) => f.key));
  for (const k of Object.keys(data))
    assert(allowed.has(k), "UNKNOWN_FIELD", `Unknown input field: ${k}`);
  const out: Record<string, unknown> = {};
  for (const f of inputs) {
    const v = Object.hasOwn(data, f.key) ? data[f.key] : creation ? f.default : undefined;
    if (v === undefined) {
      assert(!f.required, "INVALID_VALUE", `${f.label} is required.`);
      continue;
    }
    out[f.key] = normalizeValue(v, f);
  }
  assert(
    bytes(canonical(out)) <= LIMITS.inputBytes,
    "PAYLOAD_TOO_LARGE",
    "Task input exceeds 32 KiB.",
    413,
  );
  return out;
}
export function pointerGet(value: unknown, pointer: string): unknown {
  let current = value;
  if (pointer === "") return current;
  for (const part of pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part))
      return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
export function mapResult(
  result: unknown,
  fields: Field[],
  required: boolean,
): Record<string, unknown> {
  const empty =
    result === null ||
    result === "" ||
    (typeof result === "object" && Object.keys(result as object).length === 0);
  assert(!required || !empty, "INVALID_RESULT", "A nonblank result is required.");
  assert(
    bytes(canonical(result)) <= LIMITS.resultBytes,
    "PAYLOAD_TOO_LARGE",
    "Result exceeds 16 KiB.",
    413,
  );
  const mapped: Record<string, unknown> = {};
  for (const f of fields.filter((f) => f.kind === "result" && f.active)) {
    const value = pointerGet(result, f.pointer!);
    mapped[f.key] = value === null ? null : normalizeValue(value, f);
  }
  return mapped;
}
export function effectivePolicy(...overrides: Record<string, unknown>[]): Policy {
  const p = { ...DEFAULTS, ...Object.assign({}, ...overrides) } as Policy;
  assert(
    p.lease_seconds <= p.max_lifetime_seconds,
    "INVALID_VALUE",
    "Default lease duration cannot exceed maximum lifetime.",
  );
  return p;
}
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AppError(
      "INVALID_VALUE",
      "Please correct the invalid fields.",
      422,
      parsed.error.issues.map((x) => ({
        path: x.path.join("."),
        message: x.message,
      })),
    );
  return parsed.data;
}
