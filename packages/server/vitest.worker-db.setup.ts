// Per-worker test-database isolation (extends std-9's per-worktree isolation).
//
// fileParallelism runs test files in parallel worker processes; files in
// different workers must not share a database or integration suites trample
// each other's rows. This setup file runs INSIDE each worker, before any test
// module loads, and rewrites DATABASE_URL from the per-worktree test database
// (injected by the vitest.config.ts `env` block) to that worker's own clone:
// `<testDb>_w<VITEST_POOL_ID>`.
//
// Why here and not the config `env` block: the config is evaluated once in
// the MAIN vitest process, where VITEST_POOL_ID is unset (verified
// empirically — a probe config baking VITEST_POOL_ID into `env` saw "none"
// in every worker). The worker's pool id is only observable from code running
// in the worker, and it must run before db/connection.ts (which reads
// DATABASE_URL at import) — i.e. a setup file.
//
// The clones themselves are provisioned by vitest.global-setup.ts (one
// `CREATE DATABASE ... TEMPLATE` per worker slot, fresh every run). Ordering:
// this file must stay FIRST in `setupFiles`, ahead of the AC-emission helper.
import { deriveWorkerDatabaseUrl } from "./src/db/test-db-url.js";

const poolId = process.env.VITEST_POOL_ID;
if (poolId && process.env.DATABASE_URL) {
  process.env.DATABASE_URL = deriveWorkerDatabaseUrl(
    process.env.DATABASE_URL,
    poolId,
  );
}
