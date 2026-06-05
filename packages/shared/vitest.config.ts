import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// spec-129 dec-8: surface the shared AC-emission key (MEMEX_EMIT_KEY) to the test
// workers from the REPO-ROOT .env (the single shared-secret home). This package
// has no `dotenv` dependency and `vite` (loadEnv) isn't resolvable here, so a
// minimal KEY=VALUE parse suffices. Without the key the suite emits keyless and
// every event is rejected 401 (swallowed, ac-16) — tagged ACs never verify.
// Injected only when present, so in CI (no .env file) the job-level
// MEMEX_EMIT_KEY env var on process.env is left untouched.
function readRootEnv(): Record<string, string> {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
  const env: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return env; // no root .env (e.g. CI) — harmless no-op
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}
const rootEnv = readRootEnv();

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    setupFiles: ['@memex-ai-ac/vitest/setup'],
    typecheck: { enabled: false },
    env: {
      ...(rootEnv.MEMEX_EMIT_KEY ? { MEMEX_EMIT_KEY: rootEnv.MEMEX_EMIT_KEY } : {}),
      ...(rootEnv.MEMEX_EMIT ? { MEMEX_EMIT: rootEnv.MEMEX_EMIT } : {}),
    },
  },
});
