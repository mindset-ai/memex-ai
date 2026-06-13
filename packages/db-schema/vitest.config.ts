import { defineConfig } from "vitest/config";

// AC emission: the setup file wires @memex-ai-ac/vitest so tagAc(...) calls in
// tests POST pass/fail events to the canonical Memex (mindset-prod → memex.ai).
// Needs MEMEX_EMIT_KEY in the env; without it emissions are skipped (warn), the
// suite still runs. spec-279.
export default defineConfig({
  test: {
    setupFiles: ["@memex-ai-ac/vitest/setup"],
    // Package-build assertions shell out to npm pack/install; give them room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
