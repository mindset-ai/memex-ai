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
import {
  classifyPortOwner,
  isStaleBuild,
  portsToCheck,
} from "../../../../scripts/ci/e2e-preflight.mjs";

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

/** The recipe lines of one Makefile target (tab-indented lines after `name:`),
 *  with `#` comments stripped so prose ABOUT a rule can't satisfy a rule. */
function makeRecipe(target: string): string {
  const lines = MAKEFILE.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${target}:`).test(l));
  if (start === -1) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (!line.startsWith("\t")) break; // next target begins
    if (/^\t\s*@?#/.test(line)) continue; // recipe comment
    body.push(line);
  }
  return body.join("\n");
}

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

  it("covers BOTH the API and the UI port — asserted behaviourally (ac-14)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-14");

    // The first version of this test counted `await checkPortOwnership(cfg,` lines
    // in the source and asserted === 2. Adversarial review defeated it three ways:
    // wrapping the UI probe in `if (process.env.SKIP_UI_CHECK)` kept the count at 2
    // and the test GREEN while a real foreign UI was adopted; so did replacing the
    // probe with a same-shaped string literal; and an honest refactor to a `for`
    // loop made it FAIL. It passed two broken files and failed one correct one —
    // the very "regex over source treats prose as code" defect this file elsewhere
    // congratulates itself for having fixed.
    //
    // So assert the DATA the loop consumes, not the shape of the source.
    const targets = portsToCheck({ apiPort: 1111, uiPort: 2222 });
    const ports = targets.map((t) => t.port);

    expect(
      ports,
      `e2e-preflight must check BOTH the API and the UI port. portsToCheck returned ` +
        `${JSON.stringify(targets)}.\n\n` +
        `Playwright's reuseExistingServer applies to both of its webServer entries, ` +
        `so an unchecked port lets a foreign server be adopted silently.\n\n` +
        `Fix — in scripts/ci/e2e-preflight.mjs, make portsToCheck() return both:\n` +
        `  return [{ port: cfg.apiPort, label: "API" }, { port: cfg.uiPort, label: "UI" }];\n\n` +
        `Check: packages/server/src/__regression__/spec-512-workspace-isolation.regression.test.ts`,
    ).toEqual([1111, 2222]);

    expect(targets.map((t) => t.label)).toEqual(["API", "UI"]);
  });

  it("classifies a SLOW or unparseable server as occupied, never free (ac-14)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-14");

    // Both of these were live false negatives found by adversarial review, and both
    // reinstated silent adoption:
    //   * a foreign server slower than the 2s probe timeout — 1500ms was caught,
    //     2100ms printed "✓ preflight passed" even though the server's own log
    //     showed it had RECEIVED the probe. Playwright waits 60s, so it adopts it.
    //   * a 200 whose body is not JSON (SPA HTML fallback, empty body, redirect) —
    //     res.json() threw into the same catch that handles ECONNREFUSED.
    // ONLY a refused connection may be classified "free".
    const classify = (health: unknown) =>
      classifyPortOwner({
        port: 1234,
        expectedWorkspaceId: "aaaaaaaa",
        probe: async () => health,
      });

    for (const [label, health] of [
      ["timeout", { timedOut: true }],
      ["non-JSON 200", { unparseable: true }],
      ["HTTP 500", { unhealthy: 500 }],
      ["empty workspace", { status: "ok", workspace: "" }],
      ["whitespace workspace", { status: "ok", workspace: "   " }],
      ["null workspace", { status: "ok", workspace: null }],
    ] as const) {
      const verdict = await classify(health);
      expect(
        verdict.kind,
        `A ${label} response must NOT be treated as a free port — something is ` +
          `listening and cannot prove it is ours, so the run must stop. Got ` +
          `"${verdict.kind}".\n\nCheck: scripts/ci/e2e-preflight.mjs classifyPortOwner`,
      ).not.toBe("free");
      expect(verdict.kind).not.toBe("own");
    }

    // The one case that genuinely IS free: nothing listening at all.
    expect((await classify(null)).kind).toBe("free");
  });

  it("detects a PARTIAL shared build, not just an old one (ac-14)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-14");

    // Adversarial review showed the previous version of this test was doubly
    // vacuous: `existsSync("/dist")` short-circuited so the injected `listFiles`
    // fixture was NEVER invoked (0 calls), and the assertion was
    // `expect(typeof stale.stale).toBe("boolean")` — true for every possible
    // return value of the function. Of three verdicts, only `missing` was covered.
    //
    // It also showed the implementation itself was blind to its own stated
    // purpose: a max-mtime comparison cannot see a MISSING module, yet the check
    // exists for "a stale dist missing an export the UI now imports". A dist with
    // 1 of 38 modules reported {stale:false}, and one `touch` cleared a genuine
    // stale verdict. Hence the coverage comparison, tested here for real.
    const missingDist = isStaleBuild("/nonexistent/dist", "/nonexistent/src");
    expect(missingDist).toEqual({ stale: true, reason: "missing" });

    // Use this repo's real, freshly-built shared package as the healthy control.
    const realDist = join(REPO_ROOT, "packages", "shared", "dist");
    const realSrc = join(REPO_ROOT, "packages", "shared", "src");

    // Partial build: every source module present, but only ONE emitted.
    const srcModules = ["/a.ts", "/b.ts", "/c.ts"];
    const partial = isStaleBuild(realDist, realSrc, {
      listFiles: (d: string) =>
        d === realSrc ? srcModules.map((m) => d + m) : [`${d}/a.js`],
    });
    expect(
      partial,
      "A dist holding 1 of 3 source modules must be reported stale (reason " +
        "'incomplete', 2 missing) — this is the interrupted-build case the check " +
        "exists for, and a newest-mtime comparison is structurally blind to it.",
    ).toMatchObject({ stale: true, reason: "incomplete", missingCount: 2 });

    // Fully covered and freshly emitted → not stale. Proves the check can still
    // say "healthy", so the partial verdict above isn't just a checker that
    // always returns true.
    const complete = isStaleBuild(realDist, realSrc, {
      listFiles: (d: string) =>
        d === realSrc
          ? srcModules.map((m) => d + m)
          : srcModules.map((m) => d + m.replace(/\.ts$/, ".js")),
    });
    expect(complete.stale).toBe(false);
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

  it("EVERY e2e target is armed, not just e2e-cold (ac-10, ac-14)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-10");
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-14");

    // spec-512's worst defect, found by adversarial review that reproduced the
    // original incident end-to-end: the hardening was applied to `e2e-cold` only.
    // Bare `make e2e` — the command developers run while iterating, and the first
    // one in packages/ui/e2e/README.md — fell back to the literal ports and the
    // SHARED dev database, and e2e/global-setup.ts's guard early-returns when
    // MEMEX_WORKSPACE_ID is unset, so the backstop disarmed itself on exactly that
    // path. A guard that fails OPEN on its most common path is worse than none,
    // because it reads as protection.
    for (const target of ["e2e", "e2e-cold"]) {
      const recipe = makeRecipe(target);
      expect(
        recipe,
        `Makefile target "${target}" was not found — the arming assertions below ` +
          `would pass vacuously.`,
      ).not.toBe("");

      expect(
        new RegExp(`^${target}:.*\\be2e-preflight\\b`, "m").test(MAKEFILE),
        `Makefile target "${target}" must depend on e2e-preflight.\n\n` +
          `Without it, a run can silently adopt another workspace's server and ` +
          `report a pass against the wrong code.\n\n` +
          `Fix:\n  ${target}: e2e-preflight\n\n` +
          `Check: packages/server/src/__regression__/spec-512-workspace-isolation.regression.test.ts`,
      ).toBe(true);

      expect(
        recipe,
        `Makefile target "${target}" must export MEMEX_WORKSPACE_ID.\n\n` +
          `packages/ui/e2e/global-setup.ts returns early when it is unset — so ` +
          `without it the foreign-server backstop silently checks nothing.\n\n` +
          `Observed recipe:\n${recipe}\n\n` +
          `Fix — add to the recipe:\n  MEMEX_WORKSPACE_ID="$(E2E_WS_ID)" \\\n\n` +
          `Check: packages/server/src/__regression__/spec-512-workspace-isolation.regression.test.ts`,
      ).toContain("MEMEX_WORKSPACE_ID");

      expect(recipe).toContain("E2E_SERVER_PORT");
      expect(recipe).toContain("E2E_UI_PORT");

      // The ports are NOT sufficient on their own. Journeys read the API host two
      // different ways — `E2E_SERVER_PORT ?? 8090` in some files, and
      // `E2E_API_URL ?? "http://localhost:8090"` in others (e.g.
      // journey-45-spec-304, journey-8, journey-16, journey-20, journey-47,
      // journey-55, journey-65). Setting only the ports leaves that second group
      // pointing at the OLD hardcoded 8090 while the server listens on the derived
      // port, and they die with ECONNREFUSED ::1:8090 — a defect this Spec's own
      // port derivation introduced, found by running the full suite.
      for (const v of ["E2E_API_URL", "E2E_BASE_URL"]) {
        expect(
          recipe,
          `Makefile target "${target}" sets the e2e PORTS but not ${v}.\n\n` +
            `Observed recipe:\n${recipe}\n\n` +
            `Journeys that read ${v} fall back to the hardcoded localhost:8090, which\n` +
            `is not where the derived server listens — they fail ECONNREFUSED while\n` +
            `every port-reading journey passes, so the suite looks flaky rather than\n` +
            `misconfigured.\n\n` +
            `Fix — add to the recipe:\n` +
            `  E2E_API_URL="http://localhost:$(E2E_API_PORT)" \\\n` +
            `  E2E_BASE_URL="http://localhost:$(E2E_UI_PORT_)" \\\n\n` +
            `Check: packages/server/src/__regression__/spec-512-workspace-isolation.regression.test.ts`,
        ).toContain(v);
      }
    }

    // `make dev` must use derived ports too, or two worktrees cannot run dev
    // servers concurrently (Vite's strictPort makes the second exit EADDRINUSE).
    const devRecipe = makeRecipe("dev");
    expect(devRecipe).not.toBe("");
    expect(
      devRecipe,
      `\`make dev\` must bind this workspace's DERIVED ports.\n\n` +
        `Observed recipe:\n${devRecipe}\n\n` +
        `Hardcoded 8080/5173 plus Vite's strictPort:true means a second worktree's ` +
        `dev server exits EADDRINUSE.\n\n` +
        `Fix — in the dev recipe:\n  PORT=$(DEV_API_PORT) ... VITE_PORT=$(DEV_UI_PORT)\n\n` +
        `Check: packages/server/src/__regression__/spec-512-workspace-isolation.regression.test.ts`,
    ).toMatch(/DEV_API_PORT/);
    expect(devRecipe).toMatch(/DEV_UI_PORT/);

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
