import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// spec-129 dec-8: surface the shared AC-emission key (MEMEX_EMIT_KEY) to the test
// workers. The admin package is browser-side and has no `dotenv` dependency, so we
// use Vite's own loadEnv to read the REPO-ROOT .env (the single shared-secret home;
// '' prefix = load all keys, not just VITE_*). Without the key the suite emits
// keyless and every event is rejected 401 (swallowed, ac-16) — admin-tagged ACs
// never verify. Injected only when present, so in CI (no .env file) the job-level
// MEMEX_EMIT_KEY env var on process.env is left untouched.
const rootEnv = loadEnv(
  'test',
  resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  '',
);

// spec-390: the per-glob coverage tiers must not fire against a collect-only
// SHARD's partial coverage. The ui job is unsharded TODAY (so isShardRun is false
// and the tiers apply on every run), but this future-proofs workstream E's planned
// ui-sharding: when E adds `--shard=N/K`, shard runs emit collect-only zeros and a
// merge job enforces the tiers once — mirroring the server config. See the server
// vitest.config.ts shard-guard comment for the full rationale.
const isShardRun = process.argv.some(
  (a) => a === '--shard' || a.startsWith('--shard='),
);
// Collect-only thresholds for shard runs — built programmatically (no inline
// zero-valued metric literal) so it cannot become the FIRST metric token in the
// file and so trip the spec-386 floor guard, which regex-matches the first
// metric occurrence and requires it to be the global 60/58/52/58 floor below.
const COLLECT_ONLY_THRESHOLDS = Object.fromEntries(
  ['lines', 'functions', 'branches', 'statements'].map((m) => [m, 0]),
);

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    env: {
      ...(rootEnv.MEMEX_EMIT_KEY ? { MEMEX_EMIT_KEY: rootEnv.MEMEX_EMIT_KEY } : {}),
      ...(rootEnv.MEMEX_EMIT ? { MEMEX_EMIT: rootEnv.MEMEX_EMIT } : {}),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // Focus the coverage ratio on code we actually gate on. Entry points, generated
      // files, and test scaffolding are excluded so the number stays meaningful.
      // spec-390 (spec-388 dec-1): src/pages/** added — ~32% of UI test effort (incl.
      // ~10 DocDocument files) that the gate previously could not see.
      include: [
        'src/components/**/*.{ts,tsx}',
        'src/hooks/**/*.{ts,tsx}',
        'src/api/**/*.{ts,tsx}',
        'src/utils/**/*.{ts,tsx}',
        'src/agent/**/*.{ts,tsx}',
        'src/pages/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        'src/main.tsx',
        'src/App.tsx',
        'src/test/**',
        'src/components/chat/ui-tools/**',
      ],
      // Thresholds are set to the measured actuals minus a couple of points —
      // not aspirational. The gate can only ratchet up; raise each line as new
      // tests land. The 23→52 branch jump (spec-357 sus-4 / dec-1) reflects the
      // accumulated suite plus the targeted unit tests added there (specMarkdown,
      // useNeedsAttention, AcPill, clientLabel, publicSignup). Measured actuals at
      // that point: stmts 60.24%, branches 54.96%, funcs 60.68%, lines 62.56% —
      // each floor sits a few points below to stay stable, not flaky.
      // SHARD GUARD (see isShardRun / COLLECT_ONLY_THRESHOLDS above): a collect-only
      // shard run must carry NO per-path tiers (the CLI `--coverage.thresholds.*=0`
      // flags only zero the GLOBAL metrics, not per-PATH entries, so live tiers would
      // fire against partial coverage and red the shard). The ui job is unsharded
      // today (isShardRun false → full tiers apply on every run) — this future-proofs
      // workstream E's planned ui-sharding. The collect-only object is referenced as a
      // const (built programmatically, no inline zero literal) so the global floor
      // below stays the FIRST metric token, satisfying the spec-386 floor guard.
      //
      // GLOBAL default floor — KEEP FIRST in the live branch. The spec-386 floor guard
      // (src/coverage-threshold-floor.spec-386.test.ts) reads this file and regex-matches
      // the FIRST `lines:`/`functions:`/`branches:`/`statements:` occurrence, asserting
      // 60/58/52/58. The per-glob tiers below also carry those keys, so this block must
      // stay above them. spec-390 deliberately does NOT re-raise these UI numbers
      // (spec-388 dec-1: build on spec-357/spec-386, don't fight them); it only adds
      // pages/** to the include and tiers the floors.
      thresholds: isShardRun
        ? COLLECT_ONLY_THRESHOLDS
        : {
        lines: 60,
        functions: 58,
        branches: 52,
        statements: 58,
        // spec-390 (spec-388 dec-1): TIERED per-glob floors. utils is the only true
        // logic/high tier in the UI (measured br 81.3); everything else is the
        // presentational/glue ratchet tier whose behavioural net is the Playwright e2e
        // suite [per std-28]. Floors sit a few points below the 2026-06-24 measured
        // actuals so the gate is stable and blocks on a real per-dir slip.
        'src/utils/**': {
          lines: 90,
          functions: 88,
          branches: 75,
          statements: 90,
        },
        // pages/** is newly included and well covered (measured br 63.4).
        'src/pages/**': {
          lines: 70,
          functions: 64,
          branches: 58,
          statements: 68,
        },
        'src/components/**': {
          lines: 60,
          functions: 58,
          branches: 52,
          statements: 58,
        },
        'src/hooks/**': {
          lines: 58,
          functions: 65,
          branches: 44,
          statements: 55,
        },
        'src/agent/**': {
          lines: 78,
          functions: 72,
          branches: 58,
          statements: 75,
        },
        // RECORDED DRIFT (spec-390 dec-2): spec-388 dec-1 grouped api with utils/hooks
        // toward ~70% server-parity. Reality: src/api/** is ~10.5% branch — mostly
        // untested thin HTTP-client wrappers. Holding it to 70% would need a large
        // out-of-scope batch of api-client unit tests and would red the gate on day one.
        // This is a deliberate near-zero "don't regress the little we have" floor;
        // climbing it is the deferred [L] "ratchet up later" item, not this spec.
        'src/api/**': {
          lines: 10,
          functions: 10,
          branches: 8,
          statements: 10,
        },
      },
    },
  },
});
