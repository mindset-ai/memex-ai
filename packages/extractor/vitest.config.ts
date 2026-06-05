import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // web-tree-sitter loads WASM; fine in Node but needs generous timeout
    // because parser init is asynchronous and first-run downloads nothing
    // but still wires through the fs.
    testTimeout: 10000,
    include: ["src/**/*.test.ts"],
  },
});
