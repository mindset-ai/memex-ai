// spec-90 — guard the published artifact's exports.
//
// Commit 01215fe added a `development: ./src/index.ts` condition to the
// top-level exports so workspace consumers resolve TS source (a stale dist
// can't silently drop the emission key). But Vite/Vitest sets the `development`
// condition for EXTERNAL consumers too, and `src/` is not shipped (files =
// dist/README/LICENSE) — so an `npm install`ed consumer's import resolved to a
// missing `./src/index.ts` and failed: "Failed to resolve entry for package".
// This was caught by packing the tarball and importing it from a throwaway
// consumer; the in-repo tests never saw it because they resolve the same
// `development` condition against the real on-disk src.
//
// Fix: keep `development->src` at the top level (for the workspace) but override
// the published manifest via `publishConfig.exports` (dist-only). pnpm applies
// publishConfig field overrides at pack/publish time. These assertions pin that
// the published exports never reference src again.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as {
  files?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { exports?: Record<string, unknown> };
};

describe("published package exports are dist-only (no src leak)", () => {
  it("publishConfig.exports overrides the workspace dev exports and references no ./src", () => {
    const pub = pkg.publishConfig?.exports;
    expect(pub, "publishConfig.exports must shadow the development->src exports at publish").toBeTruthy();
    const json = JSON.stringify(pub);
    expect(json).not.toMatch(/src\//);
    expect(json).not.toMatch(/development/);
    expect(json).toMatch(/dist\/index\.js/);
    expect(json).toMatch(/dist\/setup\.js/);
  });

  it("the package ships dist (and never src)", () => {
    expect(pkg.files ?? []).toContain("dist");
    expect(pkg.files ?? []).not.toContain("src");
  });
});
