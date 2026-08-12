import { describe, it, expect } from "vitest";
import { tagAc } from "./index.js";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
// spec-526 — the 0.3.0 publishing escape. Its criteria are about THIS config shape
// and THIS gate, so they are verified by the same assertions rather than by a
// duplicate suite: a second copy of these checks would be a second thing to keep
// in sync, and the point of the Spec is that a check drifting from its subject is
// how the escape happened.
const AC526 = "mindset-prod/memex-building-itself/specs/spec-526/acs";

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
    // spec-526 ac-3 / ac-8 — the fix for the published package must NOT be to drop
    // this condition. That would trade a loud external failure for the silent
    // internal one of spec-129 issue-1 (a stale dist posting emissions with no key).
    tagAc(`${AC526}/ac-3`);
    tagAc(`${AC526}/ac-8`);
    const pkg = readOwnPackageJson();

    expect(pkg.exports["."].development).toBe("./src/index.ts");
    expect(pkg.exports["./setup"].development).toBe("./src/setup.ts");
  });

  it("top-level exports keep types/default on dist so tsc and non-dev consumers are unaffected", () => {
    tagAc(`${AC}/ac-23`);
    tagAc(`${AC526}/ac-8`);
    const pkg = readOwnPackageJson();

    expect(pkg.exports["."].default).toBe("./dist/index.js");
    expect(pkg.exports["."].types).toBe("./dist/index.d.ts");
    expect(pkg.exports["./setup"].default).toBe("./dist/setup.js");
    expect(pkg.exports["./setup"].types).toBe("./dist/setup.d.ts");
  });

  it("publishConfig strips the development condition so the published tarball is dist-only", () => {
    tagAc(`${AC}/ac-23`);
    tagAc(`${AC526}/ac-8`);
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
    tagAc(`${AC526}/ac-8`);
    const pkg = readOwnPackageJson();

    expect(pkg.files).toBeDefined();
    expect(pkg.files).not.toContain("src");
    expect(pkg.files).toContain("dist");
  });

  // spec-489 issue-1 / 0.3.1 — the override above is only APPLIED by pnpm.
  //
  // 0.3.0 shipped broken on 2026-08-10 because it was published with `npm publish`,
  // which ignores publishConfig field overrides: the repo-only `development ->
  // ./src` condition reached the registry, ./src is not in `files`, and every
  // external Vitest consumer failed with "Failed to resolve import". Every other
  // layer held — the override, the prepublish gate, the assertions above, and a
  // README saying not to remove either. The gate could not see it, because it
  // inspects what *pnpm* would ship.
  //
  // So the publisher itself is now a guarded precondition, and this asserts the
  // guard exists rather than trusting prose: documentation is precisely what
  // failed here, and firmer documentation would repeat it.
  // Asserts the gate's BEHAVIOUR, not its source text. Two earlier drafts of this
  // test grepped the script and both broke on regex escaping — and a text match
  // would pass just as happily on a gate that printed a warning and continued.
  // Running it is the only thing that proves it aborts.
  it("the prepublish gate refuses a non-pnpm publisher", () => {
    tagAc(`${AC}/ac-23`);
    tagAc(`${AC526}/ac-7`);
    // spec-526 ac-2 — "fails whichever tool performs the publish" is satisfied by
    // ELIMINATION, not by a second inspection: pnpm is now the only publisher that
    // gets past this line, so the tarball the gate packs is necessarily the one
    // uploaded. Proven separately (t-3) that the gate exits 0 on the very tree that
    // shipped 0.3.0 — it never could have caught this by looking harder.
    tagAc(`${AC526}/ac-2`);
    const gate = fileURLToPath(
      new URL("../scripts/verify-publish-artifact.mjs", import.meta.url),
    );

    const run = spawnSync(process.execPath, [gate], {
      encoding: "utf8",
      // What `npm publish` sets. The gate must reject it BEFORE packing anything,
      // so this path is fast and touches no registry.
      env: { ...process.env, npm_config_user_agent: "npm/10.9.0 node/v22.14.0 linux x64" },
    });

    expect(run.status, "gate must exit non-zero to abort the publish").toBe(1);
    expect(run.stderr).toContain("WRONG PUBLISHER");
    // It must name the fix, not just refuse: whoever hits this is mid-publish.
    expect(run.stderr).toContain("pnpm publish");
  });
});
