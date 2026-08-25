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

// spec-533 t-3: pin the staleness advisory OFF for every test, deterministically.
//
// The advisory fires on 1-in-500 successful single-event emissions. Left live, ANY
// test that POSTs to /api/test-events and asserts on response headers becomes
// probabilistic — and three pre-existing assertions (test-events.test.ts, spec-115
// and spec-358 criteria) do exactly that: `expect(res.headers.get("X-Memex-Warning"))
// .toBeNull()`. A ~0.6%-per-run flake introduced into other Specs' tests is not an
// acceptable cost for a telemetry nudge, and it is invisible until it bites.
//
// Pinned HERE rather than behind a production env switch on purpose: an off switch
// in the shipped code could silently disable the advisory in prod, and dec-7 chose a
// smoke probe that deliberately does NOT observe the advisory, so nothing would catch
// it. A test-only pin cannot reach production at all.
//
// Tests that need the advisory call __setAdvisoryRandomForTests themselves — see
// routes/spec-533-staleness-advisory.test.ts, which drives both outcomes explicitly.
// Their afterEach restores this pin rather than Math.random, so the deterministic
// default survives across files [per std-37: restore global stubs].
import { __setAdvisoryRandomForTests } from "./src/services/emission-advisory.js";

__setAdvisoryRandomForTests(() => 1); // 1 < 1/N is false for every N ≥ 1
