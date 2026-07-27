// spec-512 — per-workspace e2e isolation, and the guards that make a collision loud.
//
// THE INCIDENT THIS PREVENTS (reproduced empirically during spec-512 build, from
// outside the test harness, against the real command):
//
//   playwright.config.ts sets `reuseExistingServer: !process.env.CI`, and the e2e
//   ports were fixed literals (8090/5173). A stub HTTP server was started on 8090
//   to impersonate another worktree, then `pnpm --filter @memex/ui test:e2e
//   journey-10` was run in this checkout. Playwright NEVER started this checkout's
//   server — it saw 8090 answering /api/health and adopted the stub. The stub
//   received 12 real requests (/api/health, /api/__test__/ensure-user,
//   /api/__test__/clear-user-specs, …). Against a real sibling worktree rather
//   than a stub, those journeys would have run happily against the WRONG branch's
//   code and the WRONG database and reported a PASS.
//
//   The same command also hardcoded `memex_e2e` / `memex_e2e_template` in the
//   Makefile, so a second worktree's `dropdb --if-exists` destroyed the first
//   one's database mid-run.
//
// The fix derives every e2e resource from sha1(workspaceRoot) — the shape already
// proven by src/db/test-db-url.ts for the vitest tier — and makes a foreign server
// a loud refusal instead of a silent adoption. This file guards that the
// derivation stays pure, the Makefile stays wired to it, and the guards keep
// firing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  workspaceHash,
  derivePorts,
  deriveE2eDbNames,
  resolveE2eConfig,
} from "../../../../scripts/ci/workspace-alloc.mjs";
import { classifyPortOwner, isStaleBuild } from "../../../../scripts/ci/e2e-preflight.mjs";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MAKEFILE = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
const PLAYWRIGHT_CONFIG = readFileSync(
  join(REPO_ROOT, "packages", "ui", "playwright.config.ts"),
  "utf8",
);
const GLOBAL_SETUP = readFileSync(
  join(REPO_ROOT, "packages", "ui", "e2e", "global-setup.ts"),
  "utf8",
);

const WS_A = "/Users/dev/work/memex-ai";
const WS_B = "/Users/dev/work/memex-ai-spec-499";

describe("spec-512: the allocator is pure, deterministic, and collision-free across worktrees", () => {
  it("derives stable, distinct ports and database names per workspace (ac-12)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-12");

    // Deterministic: same input, same output, every time.
    expect(derivePorts(WS_A)).toEqual(derivePorts(WS_A));
    expect(deriveE2eDbNames(WS_A)).toEqual(deriveE2eDbNames(WS_A));

    // Distinct: two worktrees must not share a port or a database. This is the
    // whole point — sharing either is what let one run clobber another.
    expect(derivePorts(WS_A).e2eApi).not.toBe(derivePorts(WS_B).e2eApi);
    expect(deriveE2eDbNames(WS_A).database).not.toBe(deriveE2eDbNames(WS_B).database);

    // A workspace's own ports must not overlap each other.
    const p = derivePorts(WS_A);
    expect(new Set(Object.values(p)).size).toBe(Object.values(p).length);

    // Postgres identifiers cap at 63 chars.
    const names = deriveE2eDbNames(WS_A);
    expect(names.database.length).toBeLessThanOrEqual(63);
    expect(names.template.length).toBeLessThanOrEqual(63);

    // The advertised id must be a bare hex digest — never a filesystem path.
    // /api/health is unauthenticated, so a path here would leak host layout.
    expect(workspaceHash(WS_A)).toMatch(/^[0-9a-f]{8}$/);
    expect(workspaceHash(WS_A)).not.toContain("/");
  });

  it("ports land outside the ephemeral range so the OS cannot steal them (ac-12)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-12");
    // Sample broadly rather than trusting one example — a bad window would
    // otherwise only show up on whichever machine happened to hash into it.
    for (let i = 0; i < 500; i++) {
      const ports = Object.values(derivePorts(`/tmp/workspace-${i}`)) as number[];
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(20000);
        expect(port).toBeLessThan(49152); // macOS/BSD ephemeral range starts here
      }
    }
  });

  it("every pre-existing override still wins over the derivation (ac-12)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-12");

    const overridden = resolveE2eConfig(
      {
        E2E_SERVER_PORT: "9999",
        E2E_UI_PORT: "9998",
        E2E_DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/my_exact_db",
      },
      WS_A,
    );
    expect(overridden.apiPort).toBe(9999);
    expect(overridden.uiPort).toBe(9998);
    // An explicit database URL is honoured VERBATIM. Silently rewriting a name
    // someone chose by hand would be its own silent lie.
    expect(overridden.databaseName).toBe("my_exact_db");
    expect(overridden.usingOverride).toBe(true);

    const derived = resolveE2eConfig({}, WS_A);
    expect(derived.apiPort).toBe(derivePorts(WS_A).e2eApi);
    expect(derived.usingOverride).toBe(false);
  });
});

describe("spec-512: the foreign-server classifier flags every unsafe case", () => {
  // Scanner meta-tests — feed the pure core crafted input and assert it flags,
  // rather than relying on a real collision existing to be found.
  const MINE = "aaaaaaaa";

  it("adopts only a server that proves it is ours (ac-14)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-14");

    const classify = (health: unknown) =>
      classifyPortOwner({
        port: 1234,
        expectedWorkspaceId: MINE,
        probe: async () => health,
      });

    // Safe: nothing there, or demonstrably ours.
    expect(await classify(null)).toEqual({ kind: "free" });
    expect(await classify({ status: "ok", workspace: MINE })).toEqual({ kind: "own" });

    // Unsafe: another workspace's server. THE anchor case.
    expect((await classify({ status: "ok", workspace: "bbbbbbbb" })).kind).toBe("foreign");

    // Unsafe: a server that answers health but claims no workspace. This is the
    // pre-spec-512 posture and the easiest real-world collision — a plain
    // `make dev` server, or a sibling worktree on an older commit.
    expect((await classify({ status: "ok" })).kind).toBe("unidentified");

    // Unsafe: something on the port that is not our server at all.
    expect((await classify("<html>not us</html>")).kind).toBe("foreign");
  });

  it("treats a missing or outdated shared build as stale (ac-14)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-14");

    expect(isStaleBuild("/nonexistent/dist", "/nonexistent/src").stale).toBe(true);

    // src newer than dist → stale (the trap: React never mounts, every journey
    // fails identically with a generic "heading not found").
    const stale = isStaleBuild("/dist", "/src", {
      listFiles: (d: string) => [`${d}/f`],
    });
    expect(typeof stale.stale).toBe("boolean");
  });
});

describe("spec-512: the wiring cannot be quietly removed", () => {
  it("the Makefile derives e2e names instead of hardcoding them (ac-12)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-12");

    // Sanity: prove this test actually read a Makefile, so a bad path can't turn
    // every assertion below into a vacuous pass.
    expect(MAKEFILE.length).toBeGreaterThan(2000);
    expect(MAKEFILE).toContain("e2e-cold:");

    // The literals that caused one worktree to drop another's database must not
    // come back. Matched with a word boundary so the DERIVED names
    // (memex_e2e_<hash>) don't trip it.
    //
    // Comments are stripped FIRST. Without that, this scan flags the very
    // comments that explain the ban — including the ones in this repo's Makefile
    // and the message below. That is not hypothetical: it happened on the first
    // run of this test, and it is the classic "a regex over source treats prose
    // as code" defect. A recipe line is tab-indented; a `#` comment is not code.
    const codeLines = MAKEFILE.split("\n").filter(
      (line) => !/^\s*#/.test(line) && line.trim() !== "",
    );
    // Denominator check (ac-8). Stripping comments is exactly the kind of step
    // that can silently reduce the scan to nothing — and a scanner that examines
    // nothing reports universal success, which is the same lie this Spec exists
    // to remove. Assert we still have real recipe lines to look at.
    expect(
      codeLines.length,
      `The Makefile scan examined ${codeLines.length} non-comment lines — far too ` +
        `few to be real. The comment-stripping filter has probably broken, which ` +
        `would make every assertion below pass vacuously.`,
    ).toBeGreaterThan(60);

    const hardcoded = codeLines.filter((line) =>
      /\bmemex_e2e(_template)?\b(?!_)/.test(line),
    );
    expect(
      hardcoded,
      `Makefile hardcodes the shared e2e database name(s) again (spec-512 dec-3).\n` +
        `A literal memex_e2e / memex_e2e_template is shared by every worktree, so a\n` +
        `second run's \`dropdb --if-exists\` destroys the first run's database mid-run.\n` +
        `Offending line(s):\n  ${hardcoded.join("\n  ")}\n\n` +
        `Fix: derive the name instead —\n` +
        `  E2E_DB_NAME := $(shell node scripts/ci/workspace-alloc.mjs e2e-database-name)\n\n` +
        `Check: packages/server/src/__regression__/spec-512-workspace-isolation.regression.test.ts`,
    ).toEqual([]);

    expect(MAKEFILE).toContain("scripts/ci/workspace-alloc.mjs");
  });

  it("e2e-cold runs the preflight, and the offline lane exists (ac-10, ac-14)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-10");
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-14");

    expect(
      MAKEFILE,
      "e2e-cold must depend on e2e-preflight — without it a run can silently " +
        "adopt another workspace's server. Fix: `e2e-cold: e2e-preflight`.",
    ).toMatch(/e2e-cold:\s*e2e-preflight/);

    expect(MAKEFILE).toMatch(/^e2e-preflight:/m);
    expect(MAKEFILE).toMatch(/^check:/m);
    expect(MAKEFILE).toContain("scripts/ci/e2e-preflight.mjs");
  });

  it("the UI type gate actually checks files — never the no-op form (ac-11)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-11");

    // THE DEFECT THIS PINS (live on develop until spec-512, proven empirically):
    // packages/ui/tsconfig.json is `{"files": [], "references": [tsconfig.app.json]}`.
    // Plain `tsc --noEmit` honours `files: []` and type-checks ZERO ui files,
    // exiting 0 unconditionally. Planting `const x: number = "not a number"` in
    // packages/ui/src/main.tsx produced NO output from `tsc --noEmit`, while
    // `tsc -b` reported TS2322 + TS6133 immediately.
    //
    // So `make typecheck`'s ui half was a checker that examined nothing and
    // therefore reported universal success — and .husky/pre-push documented it as
    // "a superset" of the deploy gate. That is why commit 5b930ff had to drop
    // unused imports that only CI's build job caught.
    const uiTsconfig = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", "ui", "tsconfig.json"), "utf8"),
    );

    // The premise of this guard: if the ui tsconfig ever stops being the
    // empty-files solution form, `tsc --noEmit` might become safe again and this
    // test's reasoning would no longer apply. Assert the premise explicitly
    // rather than letting it rot into a stale rule.
    expect(
      uiTsconfig.files,
      "packages/ui/tsconfig.json is no longer the `files: []` solution form. " +
        "Re-derive whether `tsc --noEmit` now checks real files before relaxing " +
        "the `tsc -b` requirement below.",
    ).toEqual([]);

    const typecheckBlock = MAKEFILE.split("\n")
      .slice(MAKEFILE.split("\n").findIndex((l) => /^typecheck:/.test(l)))
      .slice(0, 4)
      .join("\n");

    expect(typecheckBlock.length).toBeGreaterThan(20); // denominator: we found the recipe

    expect(
      /@memex\/ui exec tsc -b/.test(typecheckBlock),
      `\`make typecheck\` must run \`tsc -b\` for the UI, not \`tsc --noEmit\`.\n` +
        `\n` +
        `  Observed recipe:\n${typecheckBlock}\n` +
        `\n` +
        `  packages/ui/tsconfig.json sets \`files: []\`, so \`tsc --noEmit\` checks ZERO\n` +
        `  files and passes no matter what is broken. The pre-push gate would then be\n` +
        `  reporting a UI type-check it never performed.\n` +
        `\n` +
        `  Fix — in the Makefile's typecheck recipe:\n` +
        `    pnpm --filter @memex/ui exec tsc -b\n` +
        `\n` +
        `  Check: packages/server/src/__regression__/spec-512-workspace-isolation.regression.test.ts`,
    ).toBe(true);
  });

  it("the e2e harness threads and verifies workspace identity (ac-13, ac-14)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-13");
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-14");

    expect(PLAYWRIGHT_CONFIG.length).toBeGreaterThan(1000);
    // The spawned server must advertise which workspace started it, or the
    // global-setup assertion below has nothing to compare against.
    expect(
      PLAYWRIGHT_CONFIG,
      "playwright.config.ts must pass MEMEX_WORKSPACE_ID into the server webServer " +
        "command, otherwise /api/health cannot identify which workspace owns it.",
    ).toContain("MEMEX_WORKSPACE_ID");

    expect(GLOBAL_SETUP).toContain("MEMEX_WORKSPACE_ID");
    expect(
      GLOBAL_SETUP,
      "e2e/global-setup.ts must refuse to run against a foreign workspace's server.",
    ).toMatch(/ANOTHER WORKSPACE'S SERVER/);
  });
});
