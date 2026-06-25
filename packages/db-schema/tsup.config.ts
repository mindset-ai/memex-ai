import { defineConfig } from "tsup";

// Build the standalone schema package. esbuild bundles the re-exported schema
// source (src/index.ts → ../../server/src/db/schema.ts) and rollup-plugin-dts
// (via `dts: true`) bundles + inlines its type-only cross-file imports, so the
// emitted dist depends on nothing in the workspace. `drizzle-orm` is the only
// import kept external — it is a real runtime dependency declared in
// package.json, not bundled in. spec-279 ac-1/ac-6/ac-7.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Everything under the drizzle-orm umbrella stays external (drizzle-orm,
  // drizzle-orm/pg-core, …). Nothing else should be external — the schema
  // source must be inlined for the package to stand alone.
  external: [/^drizzle-orm/],
});
