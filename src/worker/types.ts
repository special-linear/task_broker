export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  ADMIN_ORIGIN: string;
  BROKER_HOSTNAME: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  OWNER_EMAILS: string;
  INSTANCE_EPOCH: string;
  APP_SIGNING_SECRET: string;
  DEV_AUTH?: string;
  ABUSE_LIMITER?: RateLimit;
  LOG_QUERY_METRICS?: string;
}
export type Actor =
  | { kind: "admin"; id: string; email: string; owner: boolean }
  | {
      kind: "key";
      id: string;
      family_id: string;
      status: string;
      label: string;
    };
export interface Context {
  env: Env;
  request: Request;
  url: URL;
  actor: Actor;
  body: any;
  requestId: string | null;
}
export type Row = Record<string, any>;
