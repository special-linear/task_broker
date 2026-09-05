import { recordDto } from "./presentation";
import { z } from "zod";
import { isCollection, listCollection } from "./lists";
import { AppError, assert, iso, json, validate } from "../shared/core";
import { mutation } from "../shared/contracts";
import {
  actorId,
  all,
  audit,
  beginReceipt,
  commitReceipt,
  DB_NOW,
  effectiveHeads,
  one,
  stmt,
} from "./db";
import {
  administratorAction,
  bootstrap,
  createFamily,
  createPool,
  createProfile,
  diagnostics,
  installationAction,
  keyAction,
  updateConfiguration,
} from "./configuration";
import { fieldsFor, taskDto } from "./model";
import { createTask, editTask, getTask, listTasks, taskHistory } from "./tasks";
import {
  applyOperation,
  exportPage,
  importPreview,
  importPreviewChunk,
  operationControl,
  operationPreview,
  operationStatus,
  patchPreview,
} from "./operations";
import type { Context } from "./types";
import { decodeCursor, encodeCursor } from "./pagination";
import { schemaApply, schemaCorrect, schemaPreview } from "./schema";
import {
  portableManifest,
  portablePage,
  portableImportPreview,
  portableImportChunk,
  prune,
} from "./portable";
export async function adminRoute(c: Context): Promise<unknown> {
  const path = c.url.pathname.replace(/^\/admin-api\/v1/, "").replace(/\/$/, ""),
    method = c.request.method,
    db = c.env.DB;
  if (method === "GET") {
    if (path === "/portable-export") return portableManifest(c);
    if (path === "/portable-export/pages") return portablePage(c);
    const collection = path.slice(1);
    if (isCollection(collection)) return listCollection(c, collection);
    if (path === "/me")
      return {
        actor: c.actor,
        installation: await one(
          db,
          "SELECT setup_status,maintenance,active_epoch=? epoch_matches FROM installation WHERE id=1",
          c.env.INSTANCE_EPOCH,
        ),
      };
    if (path === "/diagnostics" || path === "/settings") return diagnostics(c);
    if (path === "/leases") return listLeases(c);
    let m = path.match(/^\/pools\/([^/]+)\/tasks$/);
    if (m) return listTasks(c, m[1]);
    m = path.match(/^\/pools\/([^/]+)\/fields$/);
    if (m) return { fields: await fieldsFor(c.env, m[1]) };
    m = path.match(/^\/tasks\/([^/]+)\/attempts$/);
    if (m) return taskHistory(c, m[1]);
    m = path.match(/^\/tasks\/([^/]+)$/);
    if (m) {
      const t = await getTask(c.env, m[1]);
      const version = await one(
        db,
        "SELECT fields_json FROM schema_versions WHERE pool_id=? AND version=?",
        t.pool_id,
        t.input_contract_revision,
      );
      return {
        task: taskDto(t),
        fields:
          t.migration_status !== "ready" && version
            ? JSON.parse(version.fields_json)
            : await fieldsFor(c.env, t.pool_id),
      };
    }
    m = path.match(/^\/operations\/([^/]+)$/);
    if (m) return operationStatus(c, m[1]);
    m = path.match(/^\/exports\/([^/]+)\/pages$/);
    if (m) return exportPage(c, m[1]);
    m = path.match(/^\/(families|pools|profiles)\/([^/]+)$/);
    if (m) {
      const row = await one(db, `SELECT * FROM ${m[1]} WHERE id=?`, m[2]);
      assert(row, "NOT_FOUND", "Resource not found.", 404);
      return recordDto(row);
    }
  }
  if (method === "POST") {
    const warning = path.match(/^\/warnings\/([^/]+)\/resolve$/);
    if (warning) {
      const r = await beginReceipt(
        c.env,
        c.actor,
        "warning.resolve",
        warning[1],
        validate(mutation.strict(), c.body),
      );
      if (!r.existing) {
        r.statements.push(stmt(db, "UPDATE warnings SET resolved=1 WHERE id=?", warning[1]));
        audit(r, "warning", warning[1], { resolved: true });
      }
      return JSON.parse((await commitReceipt(r, { resolved: true })).receipt.metadata_json);
    }
    if (path === "/portable-import/preview") return portableImportPreview(c);
    if (path === "/maintenance/prune") return prune(c);
    if (path === "/bootstrap") return bootstrap(c);
    if (path === "/families") return createFamily(c);
    if (path === "/pools") return createPool(c);
    if (path === "/profiles") return createProfile(c);
    if (path === "/keys") return keyAction(c);
    if (path === "/tasks/bulk/patches/preview") return patchPreview(c);
    if (path === "/tasks/bulk/preview") return operationPreview(c);
    if (path === "/imports/preview") return importPreview(c);
    if (path === "/exports") return operationPreview(c, true);
    if (path === "/maintenance") return installationAction(c, "maintenance");
    if (path === "/epoch/activate") return installationAction(c, "epoch");
    if (path === "/administrators") return administratorAction(c);
    let m = path.match(/^\/pools\/([^/]+)\/fields\/(preview|apply|correct)$/);
    if (m)
      return m[2] === "preview"
        ? schemaPreview(c, m[1])
        : m[2] === "apply"
          ? schemaApply(c, m[1])
          : schemaCorrect(c, m[1]);
    m = path.match(/^\/portable-import\/([^/]+)\/chunks$/);
    if (m) return portableImportChunk(c, m[1]);
    m = path.match(/^\/pools\/([^/]+)\/tasks$/);
    if (m) return createTask(c, m[1]);
    m = path.match(/^\/keys\/([^/]+)\/(rotate|soft-revoke|hard-revoke)$/);
    if (m) return keyAction(c, m[1], m[2]);
    m = path.match(/^\/operations\/([^/]+)\/apply$/);
    if (m) return applyOperation(c, m[1]);
    m = path.match(/^\/operations\/([^/]+)\/(cancel|refresh)$/);
    if (m) return operationControl(c, m[1], m[2] as "cancel" | "refresh");
    m = path.match(/^\/imports\/([^/]+)\/preview-chunks$/);
    if (m) return importPreviewChunk(c, m[1]);
    m = path.match(/^\/imports\/([^/]+)\/chunks$/);
    if (m) return applyOperation(c, m[1]);
    if (path === "/views") return saveView(c);
  }
  if (method === "PATCH") {
    if (path === "/settings") return installationAction(c, "settings");
    let m = path.match(/^\/tasks\/([^/]+)$/);
    if (m) return editTask(c, m[1]);
    m = path.match(/^\/(families|pools|profiles)\/([^/]+)$/);
    if (m) return updateConfiguration(c, m[1] as "families" | "pools" | "profiles", m[2]);
    m = path.match(/^\/administrators\/([^/]+)$/);
    if (m) return administratorAction(c, m[1]);
    m = path.match(/^\/views\/([^/]+)$/);
    if (m) return saveView(c, m[1]);
  }
  if (method === "DELETE") {
    const m = path.match(/^\/views\/([^/]+)$/);
    if (m) {
      const body = validate(
          mutation.extend({ expected_revision: z.number().int().positive() }).strict(),
          c.body,
        ),
        r = await beginReceipt(c.env, c.actor, "view.delete", m[1], body);
      if (!r.existing) {
        r.statements.push(
          stmt(
            db,
            "UPDATE requests SET guard_config=EXISTS(SELECT 1 FROM saved_views WHERE id=? AND revision=? AND (shared=1 OR owner=?)) WHERE uid=?",
            m[1],
            body.expected_revision,
            c.actor.id,
            r.uid,
          ),
          stmt(db, "DELETE FROM saved_views WHERE id=?", m[1]),
        );
        audit(r, "view", m[1], { deleted: true });
      }
      return JSON.parse((await commitReceipt(r, { deleted: true })).receipt.metadata_json);
    }
  }
  throw new AppError("NOT_FOUND", "Unknown administration endpoint.", 404);
}
async function listLeases(c: Context) {
  const filters = Object.fromEntries(
      ["pool_id", "profile_id", "family_id", "worker_id", "issuing_key_id"]
        .map((k) => [k, c.url.searchParams.get(k)])
        .filter(([, v]) => v !== null),
    ),
    limit = Number(c.url.searchParams.get("limit") ?? 100),
    scope = { kind: "leases", filters, limit },
    cursor = c.url.searchParams.get("cursor"),
    last = cursor ? await decodeCursor(c.env, cursor, scope) : null;
  const clauses = Object.keys(filters).map((k) => `h.${k}=?`),
    args: unknown[] = Object.values(filters);
  if (last) {
    clauses.push("(h.expires_at>? OR (h.expires_at=? AND h.attempt_id>?))");
    args.push(last.expiry, last.expiry, last.id);
  }
  const rows = await all(
      c.env.DB,
      `SELECT h.task_uid,h.attempt_id,h.pool_id,h.profile_id,h.family_id,h.worker_id,h.expires_at,a.task_id,k.label key_label FROM (${effectiveHeads(DB_NOW, "(SELECT active_epoch FROM installation WHERE id=1)")}) h JOIN attempts a ON a.id=h.attempt_id JOIN api_keys k ON k.id=h.issuing_key_id ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY h.expires_at,h.attempt_id LIMIT ?`,
      ...args,
      limit + 1,
    ),
    page = rows.slice(0, limit),
    tail = page.at(-1);
  return {
    rows: page.map((r) => ({ ...r, expires_at: iso(r.expires_at) })),
    cursor:
      rows.length > limit
        ? await encodeCursor(c.env, scope, { expiry: tail!.expires_at, id: tail!.attempt_id })
        : null,
  };
}
async function saveView(c: Context, id?: string) {
  const body = validate(
    mutation
      .extend({
        pool_id: z.string().uuid(),
        profile_id: z.string().uuid().nullable().optional(),
        name: z.string().min(1).max(128),
        shared: z.boolean().default(false),
        presentation: z
          .object({
            filter: z.string().default(""),
            sort: z.string().default("task_id"),
            direction: z.enum(["asc", "desc"]).default("asc"),
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
            page_size: z.union([z.literal(50), z.literal(100), z.literal(250)]).default(100),
            profile_id: z.string().nullable().optional(),
          })
          .strict(),
        expected_revision: z.number().int().positive().optional(),
      })
      .strict(),
    c.body,
  );
  const scope = id ?? "views",
    r = await beginReceipt(c.env, c.actor, id ? "view.update" : "view.create", scope, body),
    uid = id ?? crypto.randomUUID();
  if (!r.existing) {
    if (id) {
      assert(body.expected_revision, "INVALID_VALUE", "Expected revision is required.");
      r.statements.push(
        stmt(
          c.env.DB,
          "UPDATE requests SET guard_config=EXISTS(SELECT 1 FROM saved_views WHERE id=? AND revision=? AND (shared=1 OR owner=?)) WHERE uid=?",
          id,
          body.expected_revision,
          c.actor.id,
          r.uid,
        ),
      );
      r.statements.push(
        stmt(
          c.env.DB,
          "UPDATE saved_views SET name=?,presentation_json=?,profile_id=?,shared=?,revision=revision+1 WHERE id=?",
          body.name,
          json(body.presentation),
          body.profile_id ?? null,
          body.shared,
          id,
        ),
      );
    } else
      r.statements.push(
        stmt(
          c.env.DB,
          "INSERT INTO saved_views(id,pool_id,profile_id,owner,shared,name,presentation_json) VALUES(?,?,?,?,?,?,?)",
          uid,
          body.pool_id,
          body.profile_id ?? null,
          c.actor.id,
          body.shared,
          body.name,
          json(body.presentation),
        ),
      );
    audit(r, "view", uid, { name: body.name });
  }
  return JSON.parse(
    (
      await commitReceipt(r, {
        id: uid,
        revision: (body.expected_revision ?? 0) + 1,
      })
    ).receipt.metadata_json,
  );
}
