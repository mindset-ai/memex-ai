// Regression guard: the memex-app server's own vitest config wires the
// AC-emission helper as a setupFile, so the codebase phones home its own
// test results.
//
// The trap this guards: someone "cleans up" vitest.config.ts and drops the
// `setupFiles: ["@memex-ai-ac/vitest/setup"]` entry, or removes the
// workspace dep. Either way the helper stops loading, every tagAc() call
// in the server's own tests becomes a silent no-op (currentTask is never
// populated), and the dashboard sits at 0% verification with no audible
// signal.
//
// spec-89 v0.1.0: the helper is now distributed via the @memex-ai-ac/vitest
// workspace package. The wire shape changed from a relative path
// (`./src/test-setup.ts`) to the workspace package's setup export
// (`@memex-ai-ac/vitest/setup`). This guard tracks the new shape.
//
// Why source-text assertions: the wire is configuration, not behaviour.
// Asserting on Vitest's loaded config would require crafting a parent
// Vitest run; reading the config file directly catches the regression
// without that complexity.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC_89 = "mindset-prod/memex-building-itself/specs/spec-89/acs";

const SERVER_ROOT = join(__dirname, "..", "..");
const VITEST_CONFIG = join(SERVER_ROOT, "vitest.config.ts");
const SERVER_PACKAGE_JSON = join(SERVER_ROOT, "package.json");
const HELPER_PACKAGE_ROOT = join(
  SERVER_ROOT,
  "..",
  "ac-emit-vitest",
);
const WORKTREE_ROOT = join(SERVER_ROOT, "..", "..");

describe("AC emit phone-home wiring — keep the setupFile wire alive", () => {
  it("vitest.config.ts declares a setupFiles entry", () => {
    const src = readFileSync(VITEST_CONFIG, "utf-8");
    expect(src).toMatch(/setupFiles\s*:/);
  });

  it("setupFiles includes @memex-ai-ac/vitest/setup (the workspace package) [spec-89 ac-1, ac-2]", () => {
    tagAc(`${SPEC_89}/ac-1`);
    tagAc(`${SPEC_89}/ac-2`);
    const src = readFileSync(VITEST_CONFIG, "utf-8");
    // Membership, not sole-entry: the guard's intent is "the AC helper stays
    // wired", not "nothing else may be a setup file". The per-worker DB
    // isolation entry (vitest.worker-db.setup.ts, which precedes the helper)
    // is legitimate; what must never happen is the helper entry disappearing.
    expect(src).toMatch(
      /setupFiles\s*:\s*\[[^\]]*['"]@memex-ai-ac\/vitest\/setup['"][^\]]*\]/,
    );
  });

  it("server package.json depends on @memex-ai-ac/vitest [spec-89 ac-1, ac-2, ac-3]", () => {
    tagAc(`${SPEC_89}/ac-1`);
    tagAc(`${SPEC_89}/ac-2`);
    tagAc(`${SPEC_89}/ac-3`);
    const pkg = JSON.parse(readFileSync(SERVER_PACKAGE_JSON, "utf-8"));
    const dep =
      pkg.dependencies?.["@memex-ai-ac/vitest"] ??
      pkg.devDependencies?.["@memex-ai-ac/vitest"];
    expect(dep).toBeDefined();
    // Workspace-protocol dep means any change to the package source
    // propagates to consumers via pnpm's symlink — proves spec-89 ac-3
    // (consumers pick up via a normal dep bump).
    expect(dep).toMatch(/^workspace:/);
  });

  it("the @memex-ai-ac/vitest workspace package exists in tree [spec-89 ac-1]", () => {
    tagAc(`${SPEC_89}/ac-1`);
    expect(existsSync(HELPER_PACKAGE_ROOT)).toBe(true);
    expect(existsSync(join(HELPER_PACKAGE_ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(HELPER_PACKAGE_ROOT, "src", "index.ts"))).toBe(
      true,
    );
    expect(existsSync(join(HELPER_PACKAGE_ROOT, "src", "setup.ts"))).toBe(
      true,
    );
  });

  it("no test file in server/admin/shared imports from a sibling test-setup or ac-emit copy [spec-89 ac-1]", () => {
    // ac-1 in positive form: every test file's tagAc/setup import points at
    // the workspace package, not a per-package dogfood file.
    tagAc(`${SPEC_89}/ac-1`);
    const offenders: string[] = [];
    for (const pkg of ["server", "admin", "shared"]) {
      const root = join(WORKTREE_ROOT, "packages", pkg, "src");
      walkDir(root, (path) => {
        if (!path.endsWith(".test.ts") && !path.endsWith(".test.tsx")) return;
        const src = readFileSync(path, "utf-8");
        if (
          /from\s+['"]\.\.[\.\/]*test-setup(\.js)?['"]/.test(src) ||
          /from\s+['"]\.\.[\.\/]*test\/ac-emit['"]/.test(src)
        ) {
          offenders.push(path);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the workspace package's index.ts exports tagAc", () => {
    const src = readFileSync(
      join(HELPER_PACKAGE_ROOT, "src", "index.ts"),
      "utf-8",
    );
    expect(src).toMatch(/export\s+function\s+tagAc/);
  });

  it("the workspace package's setup.ts registers the per-test hooks at module load", () => {
    const src = readFileSync(
      join(HELPER_PACKAGE_ROOT, "src", "setup.ts"),
      "utf-8",
    );
    expect(src).toMatch(/beforeEach\(/);
    expect(src).toMatch(/afterEach\(/);
  });

  it("the workspace package derives the events URL from the ref's namespace (b-65 fix)", () => {
    const src = readFileSync(
      join(HELPER_PACKAGE_ROOT, "src", "derive-url.ts"),
      "utf-8",
    );
    expect(src).toMatch(/NAMESPACE_TO_BASE_URL/);
    expect(src).toMatch(/mindset-int/);
    expect(src).toMatch(/mindset-prod/);
  });

  it("smoke config loads the AC emission helper (key-gated post-deploy emission)", () => {
    tagAc(`${SPEC_89}/ac-1`);
    // POLICY REVERSAL (2026-06-05, owner decision): this guard used to assert
    // the OPPOSITE — that the smoke config must never load the helper, to
    // avoid double-emitting against the live workspace. The smoke config now
    // wires the helper deliberately so post-deploy smoke runs can tag ACs;
    // the double-emit concern is handled by key-gating (no MEMEX_EMIT_KEY in
    // env → the helper no-ops every emission). What this guard now pins is
    // the same thing it always pinned for the main config: the wire must not
    // silently disappear.
    const smokeConfig = join(SERVER_ROOT, "vitest.smoke.config.ts");
    if (!existsSync(smokeConfig)) return;
    const src = readFileSync(smokeConfig, "utf-8");
    expect(src).toMatch(
      /setupFiles\s*:\s*\[[^\]]*['"]@memex-ai-ac\/vitest\/setup['"][^\]]*\]/,
    );
  });
});

// Recursive directory walker used by the per-package import audit above.
function walkDir(root: string, visit: (path: string) => void): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walkDir(full, visit);
    else visit(full);
  }
}
