// Test-database derivation (see std-9 §local development).
//
// Tests must never run against the dev database: integration/API suites
// truncate and mutate rows out from under a `make dev` server, and a branch
// with different migrations would rewrite the shared schema. Instead, vitest
// (the vitest.config.ts `env` block + vitest.global-setup.ts) rewrites
// DATABASE_URL to a per-worktree database — `<base>_test_<sha1(worktreeRoot)[0:8]>` — so the
// dev server and any number of parallel worktrees each get their own DB on
// the same local Postgres, with zero .env divergence.
//
// Escape hatch: set MEMEX_TEST_DATABASE_URL to use an exact URL verbatim.

import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";

const DERIVED_SUFFIX = /_test_[0-9a-f]{8}$/;
const WORKER_SUFFIX = /_w\d+$/;

// Worker-count ceiling shared by vitest.config.ts (`maxWorkers`) and
// vitest.global-setup.ts (how many per-worker clones to provision) so they
// always agree. Capped at 8: each worker holds its own postgres-js pool
// (DB_POOL_MAX, default 5), so 8 workers ≈ 40 connections — comfortably
// inside a default local max_connections=100 alongside a `make dev` server.
export const TEST_MAX_WORKERS = Math.min(
  8,
  Math.max(1, availableParallelism() - 1),
);

// Pure derivation: replace the database name with `<base>_test_<hash>`,
// preserving credentials/host/port/query. Idempotent on already-derived URLs.
export function deriveTestDatabaseUrl(
  baseUrl: string,
  worktreeRoot: string,
): string {
  const url = new URL(baseUrl);
  const baseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (DERIVED_SUFFIX.test(baseName)) return baseUrl;
  // Postgres identifiers cap at 63 chars; sanitised base (≤40) + suffix (14) fits.
  const safeBase =
    (baseName || "memex").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  const hash = createHash("sha1").update(worktreeRoot).digest("hex").slice(0, 8);
  url.pathname = `/${safeBase}_test_${hash}`;
  return url.toString();
}

// Per-WORKER derivation on top of the per-worktree URL: `<testDb>_w<poolId>`.
// vitest runs test files in parallel workers (fileParallelism); files in
// different workers would trample each other's rows on a shared database, so
// each worker slot gets its own clone (created by vitest.global-setup.ts via
// CREATE DATABASE ... TEMPLATE, picked up by vitest.worker-db.setup.ts inside
// the worker — the only place VITEST_POOL_ID is visible). Idempotent on
// already-suffixed URLs because setup files re-run per test file under
// vitest's default isolation.
export function deriveWorkerDatabaseUrl(
  testUrl: string,
  poolId: string,
): string {
  const url = new URL(testUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (WORKER_SUFFIX.test(name)) return testUrl;
  const id = poolId.replace(/[^0-9]/g, "") || "0";
  // Worktree-derived names cap at 54 chars (see deriveTestDatabaseUrl); the
  // `_wN` suffix keeps the result inside Postgres's 63-char identifier limit.
  url.pathname = `/${name}_w${id}`;
  return url.toString();
}

// Env-aware resolution used by both vitest.config.ts (worker env override)
// and vitest.global-setup.ts (create/migrate) so they always agree on the
// same database.
export function resolveTestDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
  worktreeRoot: string = process.cwd(),
): string {
  if (env.MEMEX_TEST_DATABASE_URL) return env.MEMEX_TEST_DATABASE_URL;
  const base =
    env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";
  return deriveTestDatabaseUrl(base, worktreeRoot);
}
