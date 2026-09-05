import { AppError, assert, json, LIMITS, parseJSON, VERSION, validate } from "../shared/core";
import {
  authenticateAdmin,
  authenticateKey,
  checkCSRF,
  routeKind,
  validateEnvironment,
} from "./auth";
import { claim, recover, reportOrRenew } from "./broker";
import { adminRoute } from "./router";
import type { Context, Env } from "./types";
import { instrumentDatabase } from "./metrics";
import { matchRoute } from "../shared/routes";
import { resourceError } from "./db";
const security = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { db, metrics } = instrumentDatabase(env.DB);
    env = { ...env, DB: db };
    const url = new URL(request.url);
    let requestId: string | null = null;
    try {
      const kind = routeKind(request, env);
      if (kind === "health") return Response.json({ ok: true }, { headers: { ...security } });
      validateEnvironment(env);
      if (env.ABUSE_LIMITER && kind === "compute") {
        const { success } = await env.ABUSE_LIMITER.limit({
          key: `auth:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
        });
        if (!success)
          throw new AppError(
            "RATE_LIMITED",
            "Too many requests. Retry the unchanged request after the delay.",
            429,
            undefined,
            true,
          );
      }
      const actor =
        kind === "compute"
          ? await authenticateKey(request, env)
          : await authenticateAdmin(request, env);
      if (kind === "asset") {
        assert(
          request.method === "GET" || request.method === "HEAD",
          "NOT_FOUND",
          "Route not found.",
          404,
        );
        if (url.pathname === "/" || url.pathname === "/admin")
          return Response.redirect(new URL("/admin/", url).href, 302);
        const assetUrl = new URL(url);
        assetUrl.pathname = url.pathname.slice("/admin".length);
        const legitimate = /^\/(?:start|tasks(?:\/[^/]+)?|pools|keys|activity|settings)?\/?$/.test(
          assetUrl.pathname,
        );
        // Fetch the root document directly: the asset service canonicalizes
        // /index.html with a redirect that would otherwise escape /admin/.
        if (legitimate) assetUrl.pathname = "/";
        const response = await env.ASSETS.fetch(new Request(assetUrl, request));
        return new Response(response.body, {
          status: response.status,
          headers: { ...Object.fromEntries(response.headers), ...security },
        });
      }
      if (kind === "admin") checkCSRF(request, env);
      const contract = matchRoute(request.method, url.pathname);
      assert(contract, "NOT_FOUND", "Unknown API endpoint.", 404);
      if (contract.query) validate(contract.query, Object.fromEntries(url.searchParams));
      let body: unknown = {};
      if (!["GET", "HEAD"].includes(request.method)) {
        assert(
          request.headers.get("Content-Type")?.split(";")[0] === "application/json",
          "BAD_REQUEST",
          "Use application/json.",
          400,
        );
        assert(
          Number(request.headers.get("Content-Length") ?? 0) <= LIMITS.bodyBytes,
          "PAYLOAD_TOO_LARGE",
          "Request exceeds 512 KiB.",
          413,
        );
        const reader = request.body?.getReader(),
          chunks: Uint8Array[] = [];
        let length = 0;
        if (reader)
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > LIMITS.bodyBytes) {
              await reader.cancel();
              throw new AppError("PAYLOAD_TOO_LARGE", "Request exceeds 512 KiB.", 413);
            }
            chunks.push(value);
          }
        const data = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        body = parseJSON(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data));
        requestId = (body as any)?.request_id ?? null;
      }
      if (contract.schema) body = validate(contract.schema, body);
      const context: Context = { env, request, url, actor, body, requestId };
      let data: unknown;
      if (kind === "compute") {
        assert(request.method === "POST", "NOT_FOUND", "Compute endpoints require POST.", 404);
        switch (url.pathname) {
          case "/api/v1/claim":
            try {
              data = await claim(context);
            } catch (error) {
              if (
                error instanceof AppError &&
                error.code === "CONFIG_CHANGED" &&
                metrics.statements <= 24
              )
                data = await claim(context);
              else throw error;
            }
            break;
          case "/api/v1/report":
            data = await reportOrRenew(context);
            break;
          case "/api/v1/renew":
            data = await reportOrRenew(context, true);
            break;
          case "/api/v1/recover":
            data = await recover(context);
            break;
          default:
            throw new AppError("NOT_FOUND", "Unknown API endpoint.", 404);
        }
      } else data = await adminRoute(context);
      return Response.json(
        { ok: true, api_version: "1", request_id: requestId, data },
        {
          headers: {
            ...security,
            ...(env.ENVIRONMENT !== "production"
              ? {
                  "Server-Timing": `d1;dur=${metrics.sql_duration_ms.toFixed(3)}, queries;desc="${metrics.statements}", reads;desc="${metrics.rows_read}", writes;desc="${metrics.rows_written}", parameters;desc="${metrics.max_parameters}", storage;desc="${metrics.size_after}"`,
                }
              : {}),
          },
        },
      );
    } catch (error) {
      const e =
        error instanceof AppError
          ? error
          : (resourceError(error) ??
            new AppError("INTERNAL_ERROR", "The request could not be completed.", 500));
      if (!(error instanceof AppError))
        console.error(
          json({
            event: "request_failure",
            path: url.pathname,
            version: VERSION,
            error_class: error instanceof Error ? error.name : "unknown",
          }),
        );
      return Response.json(
        {
          ok: false,
          api_version: "1",
          request_id: requestId,
          error: {
            code: e.code,
            message: e.message,
            retryable: e.retryable,
            ...(e.details === undefined ? {} : { details: e.details }),
          },
        },
        {
          status: e.status,
          headers: {
            ...security,
            ...(e.retryable ? { "Retry-After": "2" } : {}),
          },
        },
      );
    } finally {
      if (env.LOG_QUERY_METRICS === "true" || Math.random() < 0.01)
        console.log(
          json({ event: "query_metrics", path: url.pathname, request_id: requestId, ...metrics }),
        );
    }
  },
};
