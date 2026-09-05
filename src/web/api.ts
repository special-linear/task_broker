import type { Envelope } from "../shared/contracts";
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: any,
  ) {
    super(message);
  }
}
export const operation = () => ({
  request_id: crypto.randomUUID(),
  request_created_at: new Date().toISOString(),
});
// Keep uncertain writes in memory. A reviewed retry of the same intent reuses
// the original wire body, including IDs and timestamps; nothing is persisted.
const pending = new Map<string, unknown>();
export async function api<T = any>(path: string, body?: unknown, method = "POST"): Promise<T> {
  let pendingKey: string | undefined;
  if (body && typeof body === "object" && "request_id" in body) {
    const semantic = { ...body } as any;
    delete semantic.request_id;
    delete semantic.request_created_at;
    pendingKey = `${method}:${path}:${JSON.stringify(semantic)}`;
    if (pending.has(pendingKey)) body = pending.get(pendingKey);
    else pending.set(pendingKey, body);
  }
  let response: Response;
  try {
    response = await fetch(`/admin-api/v1${path}`, {
      method: body === undefined ? "GET" : method,
      headers: { "Content-Type": "application/json", "X-Task-Broker": "1" },
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError("OFFLINE", "Connection lost. Your changes are still unsaved.", 0);
  }
  if (!response.headers.get("Content-Type")?.includes("application/json"))
    throw new ApiError(
      "UNAUTHENTICATED",
      "Your login may have expired. Sign in again, then retry this saved operation.",
      401,
    );
  const result = (await response.json()) as Envelope<T>;
  if (!result.ok) {
    if (pendingKey && response.status < 500 && response.status !== 429) pending.delete(pendingKey);
    throw new ApiError(
      result.error.code,
      result.error.message,
      response.status,
      result.error.details,
    );
  }
  if (pendingKey) pending.delete(pendingKey);
  return result.data;
}

/** Load bounded metadata pages; task grids keep their own server pagination. */
export async function apiRows(path: string): Promise<{ rows: any[] }> {
  const rows: any[] = [];
  let cursor: string | null = null;
  do {
    const page: { rows: any[]; cursor: string | null } = await api(
      path +
        (cursor ? (path.includes("?") ? "&" : "?") + "cursor=" + encodeURIComponent(cursor) : ""),
    );
    rows.push(...page.rows);
    cursor = page.cursor ?? null;
  } while (cursor);
  return { rows };
}
