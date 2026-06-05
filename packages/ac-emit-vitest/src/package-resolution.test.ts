import { describe, it, expect } from "vitest";
import { tagAc } from "./index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * spec-129 ac-23 — packaging guarantee.
 *
 * The original spec-129/issue-1 bug: `dist/` is gitignored and only rebuilt by
 * `prepare`/build, but Node loaded the package via `main`/`default` → `dist/`.
 * A `git pull` of `src` (which added the MEMEX_EMIT_KEY → Authorization: Bearer
 * transport) left workspace consumers running an OLD keyless `dist`, so every
 * emission posted with no key and the server rejected it 401 — silently.
 *
 * The fix: a `development` export condition pointing at TS source, which
 * vitest/Vite select, so workspace consumers can never run a stale dist. The
 * condition is repo-only — `publishConfig.exports` strips it so the published
 * npm tarball (which ships no `src/`) stays dist-only and unaffected.
 *
 * These assertions lock that config shape in place: drop the `development`
 * condition (reintroducing the bug) or stop stripping it on publish (breaking
 * npm consumers) and this test goes red.
 */
const AC = "mindset-prod/memex-building-itself/specs/spec-129/acs";

interface PackageJson {
  files?: string[];
  exports: Record<string, Record<string, string>>;
  publishConfig?: { exports?: Record<string, Record<string, string>> };
}

function readOwnPackageJson(): PackageJson {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, "../package.json");
  return JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
}

describe("package resolution config (spec-129 ac-23)", () => {
  it("top-level exports resolve workspace consumers to TS source via the development condition", () => {
    tagAc(`${AC}/ac-23`);
    const pkg = readOwnPackageJson();

    expect(pkg.exports["."].development).toBe("./src/index.ts");
    expect(pkg.exports["./setup"].development).toBe("./src/setup.ts");
  });

  it("top-level exports keep types/default on dist so tsc and non-dev consumers are unaffected", () => {
    tagAc(`${AC}/ac-23`);
    const pkg = readOwnPackageJson();

    expect(pkg.exports["."].default).toBe("./dist/index.js");
    expect(pkg.exports["."].types).toBe("./dist/index.d.ts");
    expect(pkg.exports["./setup"].default).toBe("./dist/setup.js");
    expect(pkg.exports["./setup"].types).toBe("./dist/setup.d.ts");
  });

  it("publishConfig strips the development condition so the published tarball is dist-only", () => {
    tagAc(`${AC}/ac-23`);
    const pkg = readOwnPackageJson();
    const published = pkg.publishConfig?.exports;

    expect(published, "publishConfig.exports must override exports on publish").toBeDefined();
    // No development condition survives into the published package — npm consumers
    // (whose vitest also sets the development condition) must never resolve to a
    // ./src that the tarball does not ship.
    expect(published?.["."].development).toBeUndefined();
    expect(published?.["./setup"].development).toBeUndefined();
    expect(published?.["."].default).toBe("./dist/index.js");
    expect(published?.["./setup"].default).toBe("./dist/setup.js");
  });

  it("does not ship src/ in the published tarball (files is dist + docs only)", () => {
    tagAc(`${AC}/ac-23`);
    const pkg = readOwnPackageJson();

    expect(pkg.files).toBeDefined();
    expect(pkg.files).not.toContain("src");
    expect(pkg.files).toContain("dist");
  });
});
