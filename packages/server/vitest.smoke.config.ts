import { defineConfig } from "vitest/config";

// Dedicated config for the post-deploy SMOKE suite (b-70 / dec-1).
//
// The smoke suite hits a deployed live host (SMOKE_BASE_URL) over real HTTP —
// it is the ONLY suite that does network I/O against a real environment, so it
// must NOT run in the default `make test` / vitest run. The default config
// (vitest.config.ts) excludes `src/__smoke__/**`; this config includes ONLY
// that directory and is invoked explicitly via `make smoke-int` / `make
// smoke-prod` (and the deploy.sh tail).
export default defineConfig({
  test: {
    globals: true,
    include: ["src/__smoke__/**/*.smoke.test.ts"],
    // AC emission (spec-89): register the tagAc beforeEach/afterEach so a smoke
    // test calling tagAc('<canonical-ac-ref>') POSTs its pass/fail to the
    // namespace-derived Memex (untagged smoke tests emit nothing). Mirrors the
    // default vitest.config.ts. Needs MEMEX_EMIT_KEY in env to actually land —
    // the default smoke run (no key) just no-ops the emission per the helper.
    setupFiles: ["@memex-ai-ac/vitest/setup"],
    // Wake + warm the freshly-deployed host ONCE before any test, so the timed
    // MCP journeys don't pay Cloud Run cold-start latency (>30s) and time out.
    // See warmup.global-setup.ts (std-17 / spec-243 smoke robustness).
    globalSetup: ["./src/__smoke__/warmup.global-setup.ts"],
    // Live HTTP round-trips against a shared host — keep ordering deterministic
    // (the authed tier's create→read→delete journey is sequential).
    fileParallelism: false,
    sequence: { concurrent: false },
    typecheck: { enabled: false },
    // The live host can be slow on a cold Cloud Run instance right after deploy.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Backstop to the warm-up: if a single test still trips the timeout on a cold
    // first hit, retry once — by then the instance is warm. A genuine outage fails
    // both attempts and still reds the smoke (no masking).
    retry: 1,
  },
});
