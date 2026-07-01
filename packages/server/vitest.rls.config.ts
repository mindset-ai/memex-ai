// RESTRICTED-ROLE RLS test project (spec-440 dec-1).
//
// A SEPARATE vitest project — run on its own via `make test-rls` — that connects
// the Drizzle singleton AS the non-owner `memex_app` role (RLS-subject), so the
// tenancy/seed integration suites exercise real service code under the exact RLS
// enforcement production sees. The default `vitest.config.ts` still runs as the
// owner (`postgres`), so the 200+ owner-visibility suites are unaffected (ac-8):
// this project runs ONLY `*.rls-restricted.test.ts` files, which the default
// config excludes.
//
// Why a separate project (not a flag on the main one): db/connection.ts reads
// DATABASE_URL at import and builds one singleton per process, so the connecting
// role is fixed at process start. Running the restricted role therefore needs a
// distinct process with its own env + setup — this config.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "vitest/config";
import { resolveTestDatabaseUrl, TEST_MAX_WORKERS } from "./src/db/test-db-url.js";

// Surface the repo-root .env's AC-emission key + the local .env's DATABASE_URL,
// parsed WITHOUT mutating process.env (identical rationale to vitest.config.ts).
function readEnvFile(relPath: string): Record<string, string> {
  try {
    return dotenv.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), relPath), "utf8"),
    );
  } catch {
    return {};
  }
}
const rootEnv = readEnvFile("../../.env");
const localEnv = readEnvFile(".env");
const TEST_DATABASE_URL = resolveTestDatabaseUrl({ ...process.env, ...localEnv });

export default defineConfig({
  test: {
    globals: true,
    // ONLY the restricted suites. The default config excludes this glob, so a
    // file authored here runs under memex_app and nowhere else.
    include: ["src/**/*.rls-restricted.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Provision DB + clones (reusing the main setup) AND enable memex_app LOGIN.
    globalSetup: ["./vitest.rls.global-setup.ts"],
    // 1. rewrite DATABASE_URL to this worker's clone AND to the memex_app role;
    // 2. the AC-emission helper. Order matters — the rewrite must precede any
    //    test module importing db/connection.ts (which reads DATABASE_URL once).
    setupFiles: ["./vitest.rls.worker-db.setup.ts", "@memex-ai-ac/vitest/setup"],
    fileParallelism: true,
    maxWorkers: TEST_MAX_WORKERS,
    sequence: { concurrent: false },
    env: {
      SLACK_TOKEN_ENCRYPTION: "plaintext",
      GOOGLE_CLIENT_ID: "test-google-client-id",
      DEV_USER_EMAIL: "dev@memex.ai",
      // Owner URL; vitest.rls.worker-db.setup.ts rewrites it per-worker to the
      // clone AND to the memex_app role before connection.ts imports.
      DATABASE_URL: TEST_DATABASE_URL,
      ...(rootEnv.MEMEX_EMIT_KEY ? { MEMEX_EMIT_KEY: rootEnv.MEMEX_EMIT_KEY } : {}),
      ...(rootEnv.MEMEX_EMIT ? { MEMEX_EMIT: rootEnv.MEMEX_EMIT } : {}),
      // Signup seed hooks stay OFF suite-wide (as in the main config); the seed
      // regression turns the specific seeder it needs back ON per-test.
      MEMEX_HANDHOLD_SIGNUP_SEED: "off",
      MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED: "off",
      MEMEX_DEFAULT_FACETS_SEED: "off",
    },
    typecheck: { enabled: false },
    // No coverage gate on this project — it's a targeted fidelity harness, and
    // the merged coverage tiers live on the main config (spec-390).
  },
});
