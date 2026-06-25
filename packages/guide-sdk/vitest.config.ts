import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// spec-222 / spec-129 dec-8: surface the shared AC-emission key (MEMEX_EMIT_KEY)
// to the test workers from the REPO-ROOT .env (the single shared-secret home).
// '' prefix = load all keys, not just VITE_*. Without the key the suite emits
// keyless and every event is rejected 401 (swallowed) — tagged ACs never verify.
// Injected only when present, so CI's job-level MEMEX_EMIT_KEY is left untouched.
const rootEnv = loadEnv(
  'test',
  resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  '',
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
  },
});
