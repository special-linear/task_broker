import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../src/worker/types";
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      IMPORT_DB: D1Database;
    }
  }
}
