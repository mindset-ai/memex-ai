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

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // spec-222 (KEYSTONE): tests consume @memex/guide-sdk FROM SOURCE (same as
      // vite.config) so Vitest compiles its tsx + svg imports — no pre-built bundle.
      '@memex/guide-sdk': resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../guide-sdk/src/index.ts',
      ),
    },
  },
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
      include: [
        'src/components/**/*.{ts,tsx}',
        'src/hooks/**/*.{ts,tsx}',
        'src/api/**/*.{ts,tsx}',
        'src/utils/**/*.{ts,tsx}',
        'src/agent/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        'src/main.tsx',
        'src/App.tsx',
        'src/test/**',
        'src/components/chat/ui-tools/**',
      ],
      // Thresholds are set to the current measured baseline minus a couple of points —
      // not aspirational. The first `pnpm test:coverage` run produced ~31% stmts, ~25%
      // branches, ~30% funcs, ~32% lines. CI should enforce these so the ratio can only
      // go up. Raise each line as new tests land.
      thresholds: {
        lines: 30,
        functions: 27,
        branches: 23,
        statements: 29,
      },
    },
  },
});
