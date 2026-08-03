// spec-512 ac-7 — CLAUDE.md may only name checks that actually exist.
//
// The doc rewrite reduced binding mechanics to one line each, naming the check
// that enforces them. That trade only works if the names are real: a pointer to a
// check that does not exist is worse than the prose it replaced, because the
// reader believes a machine is watching when nothing is. It is also the easiest
// thing in this Spec to break later — a target gets renamed, and the doc silently
// becomes fiction.
//
// So: parse the "Mechanics the machines enforce" table and the command blocks out
// of CLAUDE.md, and assert every `make <target>` and `scripts/...` path referenced
// there resolves.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CLAUDE_MD = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
const MAKEFILE = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");

/** Makefile targets that actually exist (`name:` at column 0, not a variable). */
const REAL_TARGETS = new Set(
  [...MAKEFILE.matchAll(/^([a-z][a-z0-9-]*):/gm)].map((m) => m[1]),
);

describe("spec-512: CLAUDE.md's pointers resolve (ac-7)", () => {
  it("the Makefile actually defines the targets CLAUDE.md tells you to run", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-7");

    // Denominator first: if the Makefile parse broke, every check below would
    // "pass" against an empty set of known targets.
    expect(
      REAL_TARGETS.size,
      `Parsed only ${REAL_TARGETS.size} Makefile targets — the parse has broken, ` +
        `which would make the assertions below vacuous.`,
    ).toBeGreaterThan(20);

    // Match ONLY inside code spans (`make x`) and fenced blocks — never bare
    // prose. The first version of this scan matched `\bmake (\w+)` anywhere and
    // flagged std-41's summary, "Hooks **make capability** a side effect of work
    // you already do", as a missing Makefile target. English is not a command
    // line; a regex over prose will keep insisting otherwise.
    //
    // Backtick pairing is done PER LINE. Matching /`([^`]+)`/ across the whole
    // document lets one unbalanced backtick shift every pair after it, so the
    // prose BETWEEN two unrelated code spans on different lines gets captured as
    // code — which is how "Hooks make capability…" survived the first fix. Per
    // line, a stray backtick can only corrupt its own line.
    const fenced = [...CLAUDE_MD.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
    const withoutFences = CLAUDE_MD.replace(/```[a-z]*\n[\s\S]*?```/g, "");
    const codeSpans = withoutFences
      .split("\n")
      .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
    const codeOnly = [...codeSpans, ...fenced].join("\n");

    const referenced = [
      ...new Set(
        [...codeOnly.matchAll(/\bmake ([a-z][a-z0-9-]*)/g)].map((m) => m[1]),
      ),
    ];
    expect(
      referenced.length,
      "CLAUDE.md should reference several make targets; found none, so this test " +
        "is checking nothing.",
    ).toBeGreaterThan(4);

    const missing = referenced.filter((t) => !REAL_TARGETS.has(t));
    expect(
      missing,
      `CLAUDE.md names make target(s) that DO NOT EXIST: ${missing.join(", ")}.\n\n` +
        `A pointer to a check that isn't there is worse than the prose it replaced —\n` +
        `the reader believes a machine is watching when nothing is.\n\n` +
        `Fix: add the target to the Makefile, or correct the reference in CLAUDE.md.\n` +
        `  make help   # lists every real target\n\n` +
        `Check: packages/server/src/__regression__/spec-512-claudemd-pointers.regression.test.ts`,
    ).toEqual([]);
  });

  it("every scripts/ path CLAUDE.md names is a real file", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-7");

    const paths = [
      ...new Set(
        [...CLAUDE_MD.matchAll(/\b(scripts\/[A-Za-z0-9._/-]+\.(?:mjs|sh|ts))/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    expect(paths.length).toBeGreaterThan(0);

    const missing = paths.filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(
      missing,
      `CLAUDE.md points at script(s) that do not exist: ${missing.join(", ")}.\n\n` +
        `Fix: correct the path, or restore the script.\n\n` +
        `Check: packages/server/src/__regression__/spec-512-claudemd-pointers.regression.test.ts`,
    ).toEqual([]);
  });

  it("does not resurrect the hardcoded dev ports the allocator replaced", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-7");

    // The pre-spec-512 doc said `make dev   # server (8080) + React UI (5173)`.
    // Once ports became per-workspace derived that line was simply false, and a
    // false instruction in the orientation doc is a context tax paid by every
    // session. Guard the correction rather than trusting it to survive.
    const proseLines = CLAUDE_MD.split("\n").filter(
      (l) => !/^\|\s*std-\d+\s*\|/.test(l),
    );
    const hardcoded = proseLines.filter((l) => /\b(8080|5173)\b/.test(l));

    expect(
      hardcoded,
      `CLAUDE.md names hardcoded port(s) again:\n  ${hardcoded.join("\n  ")}\n\n` +
        `Ports are DERIVED per workspace (scripts/ci/workspace-alloc.mjs) so parallel\n` +
        `worktrees don't collide — a fixed number here is wrong for every workspace\n` +
        `but one, and sends readers to another worktree's server.\n\n` +
        `Fix: say to run \`make dev\` and read the ports it prints, or\n` +
        `  node scripts/ci/workspace-alloc.mjs --all\n\n` +
        `Check: packages/server/src/__regression__/spec-512-claudemd-pointers.regression.test.ts`,
    ).toEqual([]);
  });
});
