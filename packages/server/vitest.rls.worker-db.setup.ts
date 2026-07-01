// Per-worker DATABASE_URL rewrite for the RESTRICTED-ROLE RLS project
// (spec-440 dec-1). Runs inside each RLS worker, before any test module imports
// db/connection.ts (which reads DATABASE_URL at import).
//
// Two hops, in order:
//   1. same as the main suite — point at this worker's private clone
//      (`<testDb>_w<VITEST_POOL_ID>`) so parallel files don't trample each other;
//   2. swap the credentials to the restricted runtime role `memex_app`, so the
//      singleton connection is SUBJECT to RLS. This is the whole point of the
//      project: real service code (seedNewPersonalMemex, mutate(), …) executes
//      as the non-owner role, so a context-less write to a gated table fails
//      here exactly as it does in prod — instead of being invisibly bypassed by
//      the owner role in the default suite.
import {
  deriveRestrictedRoleUrl,
  deriveWorkerDatabaseUrl,
} from "./src/db/test-db-url.js";

const poolId = process.env.VITEST_POOL_ID;
if (poolId && process.env.DATABASE_URL) {
  const workerUrl = deriveWorkerDatabaseUrl(process.env.DATABASE_URL, poolId);
  process.env.DATABASE_URL = deriveRestrictedRoleUrl(workerUrl);
}
