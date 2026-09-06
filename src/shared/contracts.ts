import { sortSchema } from "./sort";
import { z } from "zod";
import { fieldSchema, idSchema, policySchema, slugSchema } from "./core";
export const mutation = z.object({
  request_id: z.string().uuid(),
  request_created_at: z.iso.datetime({ offset: true }),
});
export const configurationRemovalSchema = mutation
  .extend({
    expected_revision: z.number().int().positive(),
    dependency_token: z.string().length(64),
  })
  .strict();
export const workerEnvelope = mutation.extend({
  pool: z.string().min(1).max(256),
  worker_id: idSchema,
});
export const claimSchema = workerEnvelope
  .extend({
    count: z.number().int().positive().default(1),
    lease_seconds: z.number().int().positive().optional(),
    filter: z.string().default(""),
    sorts: sortSchema.optional(),
  })
  .strict();
export const batchSchema = workerEnvelope
  .extend({ items: z.array(z.unknown()).min(1).max(20) })
  .strict();
export const leaseIdentity = z.object({
  item_id: idSchema,
  task_id: idSchema,
  attempt_id: z.string().uuid(),
  lease_token: z.string().min(1).max(256),
  lease_generation: z.number().int().nonnegative(),
  instance_epoch: z.string().min(1).max(128),
});
const runtime = {
  runtime_seconds: z.number().finite().nonnegative().optional(),
  runtime_origin: z.enum(["received", "recovered", "explicit"]).optional(),
};
export const reportItemSchema = z.discriminatedUnion("outcome", [
  leaseIdentity.extend({ outcome: z.literal("success"), result: z.unknown(), ...runtime }).strict(),
  leaseIdentity
    .extend({
      outcome: z.literal("release"),
      message: z.string().max(16384).optional(),
      details: z.unknown().optional(),
      ...runtime,
    })
    .strict(),
  leaseIdentity
    .extend({
      outcome: z.literal("permanent_failure"),
      message: z.string().trim().min(1).max(16384),
      details: z.unknown().optional(),
      ...runtime,
    })
    .strict(),
]);
export const renewItemSchema = leaseIdentity
  .extend({ lease_seconds: z.number().int().positive() })
  .strict();
export const recoverSchema = z
  .object({
    pool: z.string().min(1).max(256),
    worker_id: idSchema,
    cursor: z.string().optional(),
  })
  .strict();
export const patchSchema = z
  .object({
    data: z.record(z.string(), z.unknown()).optional(),
    unset: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    admin_note: z.string().max(32768).optional(),
    task_id: idSchema.optional(),
    max_attempts: z
      .union([z.number().int().nonnegative().nullable(), z.literal("inherit")])
      .optional(),
  })
  .strict();
export const editSchema = mutation
  .extend({
    expected_edit_revision: z.number().int().positive(),
    expected_input_revision: z.number().int().positive().optional(),
    patch: patchSchema,
  })
  .strict();
export const familySchema = mutation
  .extend({
    slug: slugSchema,
    name: idSchema,
    description: z.string().default(""),
    policy: policySchema.default({}),
  })
  .strict();
export const poolSchema = mutation
  .extend({
    family_id: z.string().uuid(),
    name: idSchema,
    profile_slug: slugSchema.optional(),
    description: z.string().default(""),
    fields: z.array(fieldSchema),
    enabled: z.boolean().default(true),
  })
  .strict();
export const profileSchema = mutation
  .extend({
    family_id: z.string().uuid(),
    pool_id: z.string().uuid(),
    slug: slugSchema,
    name: idSchema,
    policy: policySchema.default({}),
    mandatory_filter: z.string().default(""),
    projection: z.array(z.string()).nullable().default(null),
    filter_allowlist: z.array(z.string()).default([]),
  })
  .strict();
export const taskCreateSchema = mutation
  .extend({
    task_id: idSchema.optional(),
    data: z.record(z.string(), z.unknown()),
    tags: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
    admin_note: z.string().default(""),
  })
  .strict();
export type ClaimRequest = z.infer<typeof claimSchema>;
export type BatchRequest = z.infer<typeof batchSchema>;
export type ReportItem = z.infer<typeof reportItemSchema>;
export type TaskPatch = z.infer<typeof patchSchema>;
export interface TaskRow {
  task_uid: string;
  task_id: string;
  pool_id: string;
  data: Record<string, unknown>;
  tags: string[];
  enabled: boolean;
  admin_note: string;
  edit_revision: number;
  input_revision: number;
  state_revision: number;
  lease_generation: number;
  status: string;
  status_total: string;
  attempts: number;
  attempts_total: number;
  expires_at: string | null;
  result: Record<string, unknown> | null;
  previous_result: boolean;
  [key: string]: unknown;
}
export type ItemResult = {
  item_id: string | null;
  task_id?: string;
  attempt_id?: string;
  [key: string]: unknown;
} & (
  | { status: "applied" | "already_applied"; error?: never }
  | { status: "rejected"; error: { code: string; message: string } }
);
export type Envelope<T> =
  | { ok: true; api_version: "1"; request_id: string | null; data: T }
  | {
      ok: false;
      api_version: "1";
      request_id: string | null;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details?: unknown;
      };
    };
export const routes = [
  {
    method: "post",
    path: "/api/v1/claim",
    schema: claimSchema,
    summary: "Claim fenced tasks",
  },
  {
    method: "post",
    path: "/api/v1/report",
    schema: batchSchema,
    summary: "Finalize attempts with independent item outcomes",
  },
  {
    method: "post",
    path: "/api/v1/renew",
    schema: batchSchema,
    summary: "Renew active attempts",
  },
  {
    method: "post",
    path: "/api/v1/recover",
    schema: recoverSchema,
    summary: "Recover this key and worker’s active tasks",
  },
  {
    method: "post",
    path: "/admin-api/v1/families",
    schema: familySchema,
    summary: "Create a family",
  },
  {
    method: "post",
    path: "/admin-api/v1/pools",
    schema: poolSchema,
    summary: "Create a pool and its default profile",
  },
  {
    method: "post",
    path: "/admin-api/v1/profiles",
    schema: profileSchema,
    summary: "Create a profile",
  },
  {
    method: "post",
    path: "/admin-api/v1/pools/{id}/tasks",
    schema: taskCreateSchema,
    summary: "Create a typed task",
  },
  {
    method: "patch",
    path: "/admin-api/v1/tasks/{uid}",
    schema: editSchema,
    summary: "Conditionally edit a task",
  },
] as const;
