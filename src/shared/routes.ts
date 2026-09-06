import { sortSchema } from "./sort";
import { z } from "zod";
import { fieldSchema, idSchema, policySchema } from "./core";
import {
  routes as basicRoutes,
  mutation,
  configurationRemovalSchema,
  patchSchema,
  leaseIdentity,
  reportItemSchema,
  renewItemSchema,
} from "./contracts";

const uuid = z.string().uuid(),
  revision = z.number().int().positive(),
  record = z.record(z.string(), z.unknown());
export const selectionSchema = z
  .object({
    ids: z.array(uuid).max(10000).optional(),
    filter: z.string().default(""),
    include_deleted: z.boolean().default(false),
  })
  .strict();
const reason = {
  reason: z.string().max(32768).default(""),
  mode: z.enum(["soft", "full"]).optional(),
  scope: z.enum(["profile", "all"]).optional(),
  revoke: z.boolean().optional(),
};
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ ...reason, kind: z.literal("delete"), revoke: z.boolean().default(false) }).strict(),
  z.object({ ...reason, kind: z.literal("revoke") }).strict(),
  z.object({ ...reason, kind: z.literal("edit"), patch: patchSchema }).strict(),
  z
    .object({
      ...reason,
      kind: z.literal("set_tags"),
      patch: z.object({ tags: z.array(z.string()) }).strict(),
    })
    .strict(),
  z
    .object({
      ...reason,
      kind: z.literal("revoke_edit"),
      patch: patchSchema,
      revoke: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      ...reason,
      kind: z.literal("reset_edit"),
      patch: patchSchema,
      mode: z.enum(["soft", "full"]).default("soft"),
      scope: z.enum(["profile", "all"]).default("all"),
      revoke: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      ...reason,
      kind: z.literal("reset"),
      mode: z.enum(["soft", "full"]).default("soft"),
      scope: z.enum(["profile", "all"]).default("all"),
      revoke: z.boolean().default(false),
    })
    .strict(),
  ...(["enable", "disable", "duplicate", "restore"] as const).map((kind) =>
    z.object({ ...reason, kind: z.literal(kind) }).strict(),
  ),
]);
export type AdministrativeAction = z.infer<typeof actionSchema>;
export type Inheritance<T> = { kind: "inherit" } | { kind: "override"; value: T };
export const configPatchSchema = mutation
  .extend({
    expected_revision: revision,
    patch: z
      .object({
        name: idSchema.optional(),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
        archived: z.boolean().optional(),
        policy: policySchema.optional(),
        default_profile_id: uuid.nullable().optional(),
        active_cap: z.number().int().nonnegative().nullable().optional(),
        total_attempt_cap: z.number().int().nonnegative().nullable().optional(),
        required_result: z.boolean().optional(),
        mandatory_filter: z.string().optional(),
        projection: z.array(z.string()).nullable().optional(),
        filter_allowlist: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();
const bulk = mutation
  .extend({
    pool_id: uuid,
    profile_id: uuid.optional(),
    selection: selectionSchema,
    action: actionSchema,
  })
  .strict();
const exportRequest = mutation
  .extend({
    pool_id: uuid,
    profile_id: uuid.optional(),
    selection: selectionSchema,
    history: z.boolean().default(false),
    sorts: sortSchema.optional(),
  })
  .strict();
const importPreview = mutation
  .extend({
    pool_id: uuid,
    mode: z.enum(["add", "update", "upsert", "legacy"]),
    total: z.number().int().min(0).max(10000),
    mapping: z.record(z.string(), z.string()).default({}),
  })
  .strict();
const importChunk = mutation
  .extend({
    start: z.number().int().nonnegative(),
    rows: z
      .array(
        z
          .object({
            task_id: z.string().optional(),
            data: record,
            tags: z.array(z.string()).optional(),
            enabled: z.boolean().optional(),
            legacy_result: z.unknown().optional(),
            legacy_completed: z.boolean().optional(),
            legacy_attempts: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
const apply = mutation
  .extend({
    start: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const keyCreate = mutation.extend({ family_id: uuid.optional(), label: idSchema }).strict(),
  revoke = mutation.extend({ reason: z.string().min(1) }).strict();
const admin = mutation
  .extend({
    subject: z.string().min(1).optional(),
    email: z.email().optional(),
    active: z.boolean().default(true),
  })
  .strict();
const view = mutation
  .extend({
    pool_id: uuid,
    profile_id: uuid.nullable().optional(),
    name: z.string().min(1).max(128),
    shared: z.boolean().default(false),
    presentation: z
      .object({
        filter: z.string().default(""),
        sort: z.string().optional(),
        sorts: sortSchema.optional(),
        direction: z.enum(["asc", "desc"]).optional(),
        columns: z
          .array(
            z
              .object({
                field: z.string(),
                width: z.number().optional(),
                visible: z.boolean().optional(),
              })
              .strict(),
          )
          .default([]),
        page_size: z
          .union([z.literal(50), z.literal(100), z.literal(250), z.literal("all")])
          .default(100),
        profile_id: z.string().nullable().optional(),
      })
      .strict(),
    expected_revision: revision.optional(),
  })
  .strict();

export const errorSchema = z.object({
  ok: z.literal(false),
  api_version: z.literal("1"),
  request_id: uuid.nullable(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  }),
});
const itemBase = z
  .object({
    item_id: z.string().nullable(),
    task_id: z.string().optional(),
    attempt_id: z.string().optional(),
  })
  .passthrough();
export const itemResultSchema = z.discriminatedUnion("status", [
  itemBase.extend({ status: z.literal("applied") }),
  itemBase.extend({ status: z.literal("already_applied") }),
  itemBase.extend({
    status: z.literal("rejected"),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export const taskGrantSchema = leaseIdentity.omit({ item_id: true }).extend({
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  maximum_expires_at: z.iso.datetime(),
  input_revision: revision,
  attempts: z.number().int(),
  attempts_total: z.number().int(),
  tags: z.array(z.string()),
  data: record,
});
const claimResponse = z.object({
  canonical_profile_id: uuid,
  requested_count: z.number(),
  granted_count: z.number(),
  limiting_reasons: z.array(z.string()),
  tasks: z.array(taskGrantSchema),
  retry_after_seconds: z.number().optional(),
});
const batchResponse = z
  .object({ items: z.array(itemResultSchema), replayed: z.boolean().optional() })
  .passthrough();
export interface RouteContract {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  schema?: z.ZodType;
  response: z.ZodType;
  summary: string;
  query?: z.ZodObject;
}
const objectResponse = record;
const endpoint = (
  method: RouteContract["method"],
  path: string,
  schema: z.ZodType | undefined,
  summary: string,
  response: z.ZodType = objectResponse,
): RouteContract => ({ method, path: `/admin-api/v1${path}`, schema, response, summary });
const get = (path: string, summary: string) => endpoint("get", path, undefined, summary);
export const routes: RouteContract[] = [
  ...basicRoutes.map((r) => ({
    ...r,
    response:
      r.path === "/api/v1/claim"
        ? claimResponse
        : r.path === "/api/v1/report" || r.path === "/api/v1/renew"
          ? batchResponse
          : r.path === "/api/v1/recover"
            ? z
                .object({
                  tasks: z.array(taskGrantSchema.passthrough()),
                  cursor: z.string().nullable(),
                })
                .passthrough()
            : objectResponse,
  })),
  ...[
    "me",
    "settings",
    "diagnostics",
    "administrators",
    "families",
    "pools",
    "profiles",
    "keys",
    "views",
    "leases",
    "audit",
    "warnings",
    "operations",
  ].map((p) => get(`/${p}`, `List or inspect ${p}`)),
  ...["families", "pools", "profiles"].flatMap((p) => [
    get(`/${p}/{id}`, `Inspect ${p}`),
    endpoint("patch", `/${p}/{id}`, configPatchSchema, `Conditionally update ${p}`),
    get(`/${p}/{id}/removal`, `Review deletion eligibility and dependencies for ${p}`),
    endpoint(
      "delete",
      `/${p}/{id}`,
      configurationRemovalSchema,
      `Delete unused ${p} after reviewing dependencies`,
    ),
  ]),
  get("/pools/{id}/fields", "Current input and result schema"),
  get("/pools/{id}/claim-sort-indexes", "List configured claim sort indexes"),
  endpoint(
    "post",
    "/pools/{id}/claim-sort-indexes",
    mutation.extend({ name: z.string().trim().min(1).max(128), sorts: sortSchema.min(1) }).strict(),
    "Configure a reusable claim sort index",
  ),
  endpoint(
    "post",
    "/claim-sort-indexes/{id}/build",
    mutation.extend({ expected_revision: revision }).strict(),
    "Build or rebuild a configured index",
  ),
  endpoint(
    "delete",
    "/claim-sort-indexes/{id}",
    mutation.extend({ expected_revision: revision }).strict(),
    "Delete a configured index",
  ),
  get("/pools/{id}/tasks", "Filter, sort and paginate tasks"),
  get("/tasks/{uid}", "Task detail"),
  get("/tasks/{uid}/attempts", "Immutable attempt history"),
  get("/operations/{id}", "Progress, frozen revisions and errors"),
  get("/exports/{id}/pages", "Bounded export pages"),
  get("/portable-export", "Portable installation manifest"),
  get("/portable-export/pages", "Logical records without live credentials"),
  endpoint(
    "post",
    "/tasks/bulk/patches/preview",
    mutation
      .extend({
        pool_id: uuid,
        rows: z
          .array(
            z
              .object({ task_uid: uuid, expected_edit_revision: revision, patch: patchSchema })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    "Freeze per-row paste drafts with expected revisions",
  ),
  endpoint("post", "/bootstrap", mutation.strict(), "Owner-only initial activation"),
  endpoint("post", "/tasks/bulk/preview", bulk, "Freeze selected task IDs and expected revisions"),
  endpoint("post", "/exports", exportRequest, "Freeze export IDs"),
  endpoint("post", "/operations/{id}/apply", apply, "Apply the next bounded atomic chunk"),
  endpoint("post", "/operations/{id}/cancel", mutation.strict(), "Cancel future chunks"),
  endpoint(
    "post",
    "/operations/{id}/refresh",
    mutation.strict(),
    "Deliberately extend preview retention",
  ),
  endpoint("post", "/imports/preview", importPreview, "Create reviewed import"),
  endpoint("post", "/imports/{id}/preview-chunks", importChunk, "Validate and freeze mapped rows"),
  endpoint("post", "/imports/{id}/chunks", apply, "Apply frozen import rows"),
  endpoint(
    "post",
    "/pools/{id}/fields/preview",
    mutation.extend({ expected_revision: revision, fields: z.array(fieldSchema) }).strict(),
    "Review compatible or resumable schema change",
  ),
  endpoint(
    "post",
    "/pools/{id}/fields/apply",
    mutation.extend({ operation_id: uuid, revoke: z.boolean().default(false) }).strict(),
    "Apply or resume schema migration",
  ),
  endpoint(
    "post",
    "/pools/{id}/fields/correct",
    mutation.extend({ operation_id: uuid, task_uid: uuid, data: record }).strict(),
    "Correct a rejected conversion",
  ),
  endpoint("post", "/keys", keyCreate, "Issue a secret once; receipts are redacted"),
  endpoint(
    "post",
    "/keys/{id}/rotate",
    keyCreate,
    "Issue a replacement and soft-revoke the prior key",
  ),
  ...(["soft-revoke", "hard-revoke"] as const).map((p) =>
    endpoint("post", `/keys/{id}/${p}`, revoke, `${p} a compute key`),
  ),
  endpoint("post", "/administrators", admin, "Add an allowed Access subject"),
  endpoint("patch", "/administrators/{id}", admin, "Enable or disable an administrator"),
  endpoint("post", "/views", view, "Save personal or shared view"),
  endpoint("patch", "/views/{id}", view, "Conditionally update view"),
  endpoint(
    "delete",
    "/views/{id}",
    mutation.extend({ expected_revision: revision }).strict(),
    "Conditionally delete a view",
  ),
  endpoint("post", "/warnings/{id}/resolve", mutation.strict(), "Resolve an operational warning"),
  endpoint(
    "post",
    "/maintenance",
    mutation.extend({ maintenance: z.boolean(), reason: z.string().optional() }).strict(),
    "Owner-only maintenance barrier",
  ),
  endpoint(
    "post",
    "/epoch/activate",
    mutation.extend({ reason: z.string().optional() }).strict(),
    "Activate external recovery epoch while closed",
  ),
  endpoint("post", "/maintenance/prune", mutation.strict(), "Bounded transient cleanup"),
  endpoint(
    "patch",
    "/settings",
    mutation
      .extend({
        expected_revision: revision,
        defaults: policySchema,
        reason: z.string().optional(),
      })
      .strict(),
    "Update global defaults",
  ),
  endpoint(
    "post",
    "/portable-import/preview",
    mutation
      .extend({
        manifest: z
          .object({
            format: z.literal("task-broker-portable"),
            format_version: z.literal(1),
            schema_version: z.number().int().min(1).max(5),
          })
          .passthrough(),
        total_records: z.number().int().nonnegative(),
      })
      .strict(),
    "Owner-reviewed import into an empty maintained installation",
  ),
  endpoint(
    "post",
    "/portable-import/{id}/chunks",
    mutation.extend({ table: z.string(), rows: z.array(record).max(100) }).strict(),
    "Import bounded logical records, disabling inherited authority",
  ),
];
const time = z.iso.datetime().nullable();
export const taskRowSchema = z.object({
  task_uid: uuid,
  pool_id: uuid,
  task_id: z.string(),
  data: record,
  result: record.nullable(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  admin_note: z.string().optional(),
  max_attempts: z
    .union([z.number().int().nonnegative().nullable(), z.literal("inherit")])
    .optional(),
  edit_revision: revision,
  input_revision: revision,
  state_revision: revision,
  lease_generation: z.number().int().nonnegative(),
  attempt_sequence: z.number().int().nonnegative().optional(),
  attempts: z.number().int().nonnegative().optional(),
  attempts_total: z.number().int().nonnegative().optional(),
  status: z
    .enum(["pending", "leased", "completed", "failed", "disabled", "exhausted", "deleted"])
    .optional(),
  status_total: z.string().optional(),
  expires_at: time.optional(),
  completed_at: time.optional(),
  deleted_at: time.optional(),
  previous_result: z.boolean().optional(),
  migration_status: z.enum(["ready", "migrating"]).optional(),
});
const configRow = z
  .object({ id: uuid, name: z.string(), enabled: z.number().int(), config_revision: revision })
  .passthrough();
const opItem = z
  .object({
    ordinal: z.number().int(),
    task_uid: uuid.nullable(),
    status: z.enum(["pending", "applied", "already_applied", "rejected"]),
    outcome: z.unknown().optional(),
  })
  .passthrough();
const keyMetadata = z.object({
  id: uuid,
  family_id: uuid,
  label: z.string(),
  prefix: z.string(),
  status: z.enum(["active", "soft_revoked", "hard_revoked"]),
  issued_at: z.iso.datetime(),
  revoked_at: time,
  last_used_at: time,
});
for (const route of routes) {
  const p = route.path.replace("/admin-api/v1", "");
  if (route.method === "get") {
    if (["/families", "/pools", "/profiles"].includes(p))
      route.response = z.object({
        rows: z.array(configRow.partial().extend({ id: uuid })),
        cursor: z.string().nullable().optional(),
      });
    else if (["/families/{id}", "/pools/{id}", "/profiles/{id}"].includes(p))
      route.response = configRow;
    else if (/^\/(families|pools|profiles)\/\{id\}\/removal$/.test(p))
      route.response = z.object({
        id: uuid,
        name: z.string(),
        expected_revision: revision,
        dependency_token: z.string(),
        can_delete: z.boolean(),
        reasons: z.array(z.string()),
        profiles: z.array(
          z.object({ id: uuid, family_id: uuid, name: z.string(), slug: z.string(), revision }),
        ),
        defaults: z.array(z.object({ id: uuid, name: z.string(), slug: z.string(), revision })),
        revoked_key_count: z.number().int(),
      });
    else if (p === "/keys")
      route.response = z.object({
        rows: z.array(keyMetadata.partial().extend({ id: uuid })),
        cursor: z.string().nullable().optional(),
      });
    else if (p === "/pools/{id}/fields")
      route.response = z.object({ fields: z.array(fieldSchema) });
    else if (p === "/pools/{id}/tasks")
      route.response = z.object({
        rows: z.array(taskRowSchema),
        fields: z.array(fieldSchema),
        pool: configRow,
        total: z.number().int(),
        counted_at: z.iso.datetime(),
        cursor: z.string().nullable(),
      });
    else if (p === "/tasks/{uid}")
      route.response = z.object({ task: taskRowSchema, fields: z.array(fieldSchema) });
    else if (p === "/tasks/{uid}/attempts")
      route.response = z
        .object({
          attempts: z.array(
            z
              .object({
                id: uuid,
                attempt_sequence: z.number().int(),
                worker_id: z.string(),
                outcome: z.string().nullable(),
              })
              .passthrough(),
          ),
          cursor: z.string().nullable().optional(),
          imported_history: record.nullable().optional(),
        })
        .passthrough();
    else if (p === "/operations/{id}")
      route.response = z
        .object({
          id: uuid,
          kind: z.string(),
          status: z.string(),
          total: z.number().int(),
          processed: z.number().int(),
          action: record,
          selection: record,
          items: z.array(opItem),
          counts: z.array(z.object({ status: z.string(), count: z.number().int() })),
          expired: z.boolean(),
        })
        .passthrough();
    else if (p === "/me")
      route.response = z.object({
        actor: z.object({
          kind: z.literal("admin"),
          id: z.string(),
          email: z.string(),
          owner: z.boolean(),
        }),
        installation: z.object({
          setup_status: z.string(),
          maintenance: z.number().int(),
          epoch_matches: z.number().int(),
        }),
      });
    else if (["/diagnostics", "/settings"].includes(p))
      route.response = z.object({
        version: z.string(),
        schema_version: z.number().int(),
        config_revision: revision,
        setup_status: z.string(),
        maintenance: z.boolean(),
        epoch_matches: z.boolean(),
        environment: z.string(),
        admin_origin: z.string(),
        broker_hostname: z.string(),
        counts: z.object({
          tasks: z.number().int(),
          attempts: z.number().int(),
          active_leases: z.number().int(),
          receipts: z.number().int(),
        }),
        estimated_bytes: z.number().int(),
        defaults: policySchema,
        sampled_at: z.iso.datetime(),
      });
    else if (
      ["/leases", "/views", "/audit", "/warnings", "/operations", "/administrators"].includes(p)
    )
      route.response = z.object({
        rows: z.array(record),
        cursor: z.string().nullable().optional(),
      });
  } else {
    if (p === "/tasks/{uid}") route.response = taskRowSchema;
    else if (p.endsWith("/preview") || p === "/exports")
      route.response = z.object({ operation_id: uuid }).passthrough();
    else if (p === "/operations/{id}/apply" || p === "/imports/{id}/chunks")
      route.response = z.object({
        operation_id: uuid,
        items: z.array(opItem),
        replayed: z.boolean(),
      });
    else if (p === "/families" || p === "/profiles") route.response = z.object({ id: uuid });
    else if (p === "/pools") route.response = z.object({ id: uuid, profile_id: uuid });
    else if (p === "/pools/{id}/tasks")
      route.response = z.object({ task_uid: uuid, task_id: z.string() });
    else if (p === "/keys" || p === "/keys/{id}/rotate")
      route.response = z
        .object({
          id: uuid,
          label: z.string(),
          secret_available: z.boolean(),
          key: z.string().optional(),
        })
        .passthrough();
  }
}
const pageQuery = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(250).optional(),
    filter: z.string().max(4096).optional(),
    sort: z.string().optional(),
    sorts: z
      .string()
      .max(8192)
      .describe("URL-encoded JSON SortSpec array. Cannot be combined with legacy sort/direction.")
      .optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    profile_id: uuid.optional(),
    pool_id: uuid.optional(),
    family_id: uuid.optional(),
    worker_id: idSchema.optional(),
    issuing_key_id: uuid.optional(),
    fields: z.string().optional(),
    include_deleted: z.enum(["true", "false"]).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
    after: z.coerce.number().int().min(-1).optional(),
    sequence: z.coerce.number().int().nonnegative().optional(),
    table: z.string().optional(),
    kind: z.string().optional(),
  })
  .strict();
for (const route of routes) if (route.method === "get") route.query = pageQuery;
export function matchRoute(method: string, path: string) {
  return routes.find(
    (r) =>
      r.method === method.toLowerCase() &&
      new RegExp(`^${r.path.replace(/\{[^}]+\}/g, "[^/]+")}/?$`).test(path),
  );
}
export const componentSchemas = {
  ReportItem: reportItemSchema,
  RenewItem: renewItemSchema,
  TaskGrant: taskGrantSchema,
  ItemResult: itemResultSchema,
  ErrorEnvelope: errorSchema,
  TaskRow: taskRowSchema,
};
