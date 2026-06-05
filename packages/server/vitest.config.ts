import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "vitest/config";
import { resolveTestDatabaseUrl, TEST_MAX_WORKERS } from "./src/db/test-db-url.js";

// spec-129 dec-8: surface the shared AC-emission key (MEMEX_EMIT_KEY) to the
// test workers from the REPO-ROOT .env (the single shared-secret home). This
// loading used to live in vitest.setup.ts; when the DATABASE_URL override moved
// to the `env` block below, the key loading must move with it or the suite
// emits keyless and every event is rejected 401 (swallowed, ac-16) — caught by
// src/__regression__/spec-129-ci-emission-key.test.ts. Parsed without mutating
// process.env; injected only when present, so in CI (no .env file) the
// job-level MEMEX_EMIT_KEY env var is left untouched. Mirrors the same block in
// packages/shared/vitest.config.ts (which hand-rolls the parse — no dotenv dep).
function readRootEnv(): Record<string, string> {
  try {
    return dotenv.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"), "utf8"),
    );
  } catch {
    return {}; // no root .env (e.g. CI) — harmless no-op
  }
}
const rootEnv = readRootEnv();

// Per-worktree test-database isolation (std-9 §local development): derive the
// isolated `<db>_test_<hash(worktree)>` URL HERE, at config-evaluation time,
// and inject it via the `env` block below so it's in place before any test
// module — db/connection.ts reads DATABASE_URL at import — connects.
//
// NOTE: this config is evaluated ONCE, in the main vitest process (an earlier
// comment here claimed per-worker evaluation; a probe disproved that —
// VITEST_POOL_ID is never visible at config-eval time). The per-WORKER hop
// (`_w<poolId>` clone, enabling fileParallelism) therefore happens in
// vitest.worker-db.setup.ts, which runs inside each worker.
// Escape hatch: MEMEX_TEST_DATABASE_URL pins an exact URL (workers still
// append their `_w<poolId>` suffix to it).
//
// The local packages/server/.env may contain DATABASE_URL (non-default host,
// port, or credentials). Parse it WITHOUT mutating process.env so that the
// same URL is used here (config time) and in vitest.global-setup.ts (which
// uses `import "dotenv/config"` — same file). Without this, the config falls
// back to the hardcoded default (localhost:5432/postgres) while global-setup
// uses the local .env, and workers connect to a different host than where the
// test databases were created.
function readLocalEnv(): Record<string, string> {
  try {
    return dotenv.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), ".env"), "utf8"),
    );
  } catch {
    return {};
  }
}
const localEnv = readLocalEnv();
const TEST_DATABASE_URL = resolveTestDatabaseUrl({ ...process.env, ...localEnv });

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // globalSetup creates + migrates the per-worktree test database once per
    // run, in the main process, before any worker starts — then clones it
    // into one database per worker slot (TEMPLATE copy, milliseconds each).
    // Tests therefore never touch the dev database a `make dev` server is
    // using, and parallel workers never touch each other's data.
    globalSetup: ["./vitest.global-setup.ts"],
    // Two setup entries, order matters:
    //  1. vitest.worker-db.setup.ts — rewrites DATABASE_URL to this worker's
    //     own database clone (see that file for why this can't live in the
    //     `env` block). Must run before any test module imports
    //     db/connection.ts, and before the AC helper.
    //  2. AC emission helper (@memex-ai-ac/vitest per spec-89). Registers
    //     beforeEach/afterEach hooks at module load so any test calling
    //     tagAc('<canonical-ac-ref>') POSTs a pass/fail event to
    //     /api/test-events. Untagged tests are unaffected. The AC phone-home
    //     regression guard pins that this entry stays present (spec-89
    //     ac-1/ac-2).
    setupFiles: ["./vitest.worker-db.setup.ts", "@memex-ai-ac/vitest/setup"],
    // The __smoke__ suite hits a deployed live host over real HTTP (b-70). It is
    // explicitly OUT of the default run so local + CI never touch the network —
    // run it via `make smoke-int` / `make smoke-prod` (vitest.smoke.config.ts).
    // (Vitest's built-in defaults — node_modules, dist, config files — are
    // re-listed here because providing `exclude` overrides them.)
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "src/__smoke__/**",
    ],
    // Test files run in parallel workers; each worker owns a private clone of
    // the migrated test database (see vitest.worker-db.setup.ts), so DB-backed
    // suites can't interfere across workers. Within a file, tests still run
    // sequentially (sequence.concurrent: false) — same semantics as the old
    // fully-serial config, minus the wall-clock cost.
    fileParallelism: true,
    maxWorkers: TEST_MAX_WORKERS,
    sequence: {
      concurrent: false,
    },
    // Default env vars for tests so dev environments don't need GCP/OAuth credentials.
    // Each is the explicit dev escape hatch the corresponding production module provides;
    // see services/.ee/slack/crypto.ts for the SLACK_TOKEN_ENCRYPTION contract.
    // GOOGLE_CLIENT_ID is set to a placeholder so session middleware respects the test's
    // Bearer token instead of falling through to the dev-user auto-login (isDevMode()
    // returns false when GOOGLE_CLIENT_ID is set; see middleware/session.ts).
    env: {
      SLACK_TOKEN_ENCRYPTION: "plaintext",
      GOOGLE_CLIENT_ID: "test-google-client-id",
      // Per-worktree DB isolation: applied to process.env before any test
      // module loads, so db/connection.ts connects to the isolated database
      // (see TEST_DATABASE_URL above). Replaces the old vitest.setup.ts
      // setupFile, which would have forced a two-entry setupFiles array and
      // broken the AC phone-home regression guard.
      DATABASE_URL: TEST_DATABASE_URL,
      // Shared AC-emission secrets from the repo-root .env (see readRootEnv
      // above) — the other job the retired vitest.setup.ts used to do.
      ...(rootEnv.MEMEX_EMIT_KEY ? { MEMEX_EMIT_KEY: rootEnv.MEMEX_EMIT_KEY } : {}),
      ...(rootEnv.MEMEX_EMIT ? { MEMEX_EMIT: rootEnv.MEMEX_EMIT } : {}),
    },
    typecheck: { enabled: false },
    coverage: {
      // v8 provider is faster than istanbul and ships with vitest. See @vitest/coverage-v8.
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      // Only measure what we actually want to gate on. Excluding entry points, type-only
      // files, generated migrations, and test scaffolding keeps the ratio meaningful.
      include: ["src/services/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.integration.test.ts",
        "**/*.api.test.ts",
        "**/*.security.test.ts",
        "**/*.perf.test.ts",
        "**/*.regression.test.ts",
        "src/services/test-helpers.ts",
      ],
      // t-17 AC: fail if server service coverage drops below 80%. Lines/statements/
      // functions pinned at 80. Branch coverage is held at 70 because a handful of
      // service files have defensive `if` branches that are only reachable via tests
      // we haven't written yet (e.g., `shared/blockers.ts` is exercised through route
      // tests that mock it, so its branches don't register here). Raise this bar as
      // direct unit coverage lands.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
