import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Surface the shared AC-emission key (MEMEX_EMIT_KEY) to the test workers from
// the REPO-ROOT .env (the single shared-secret home), so tagAc(...) emissions for
// spec-371 land. Minimal KEY=VALUE parse — this package has no dotenv dep. Mirrors
// packages/shared/vitest.config.ts.
function readRootEnv() {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env; // no root .env (e.g. CI) — harmless no-op
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}
const rootEnv = readRootEnv();

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.js", "lib/**/*.test.js"],
    setupFiles: ["@memex-ai-ac/vitest/setup"],
    env: {
      ...(rootEnv.MEMEX_EMIT_KEY ? { MEMEX_EMIT_KEY: rootEnv.MEMEX_EMIT_KEY } : {}),
      ...(rootEnv.MEMEX_EMIT ? { MEMEX_EMIT: rootEnv.MEMEX_EMIT } : {}),
    },
  },
});
