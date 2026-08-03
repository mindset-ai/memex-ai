// diff → affected tests (spec-512 ac-4).
//
//   node scripts/ci/affected-tests.mjs                 # vs merge-base with develop
//   node scripts/ci/affected-tests.mjs --base main
//   node scripts/ci/affected-tests.mjs --json          # machine-readable
//   node scripts/ci/affected-tests.mjs --files a.ts b.ts
//
// An agent that changed one file has no cheap way to compute the minimal relevant
// test set, so it either runs everything (slow) or guesses (unsafe). This maps a
// diff to the suites worth running first.
//
// ── The one rule that makes this safe ────────────────────────────────────────
// IT MUST NEVER RETURN SILENTLY EMPTY. An unrecognised path maps to "run
// everything", never to "nothing to do". A mapper that shrugs at a file it does
// not understand and prints an empty list is precisely the confident-wrong-answer
// this Spec exists to delete: the agent reads "no tests affected" as "safe".
//
// And it is ADVISORY. Every human-readable run says so, because the minimal set
// is a starting point for the local loop — CI still runs the full matrix, and
// that is what actually gates the merge.

import { execFileSync } from "node:child_process";

const SELF = "scripts/ci/affected-tests.mjs";

// Ordered, first-match-wins. Each rule maps a path pattern to the commands worth
// running. `full: true` means the change is broad enough that narrowing is a lie.
export const RULES = [
  // Anything that reshapes the build, the deps, or the test harness itself
  // invalidates narrowing entirely.
  { test: /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|biome\.json)$/, full: true, why: "workspace-wide build/dep/lint config" },
  { test: /^packages\/[^/]+\/(package\.json|tsconfig[^/]*\.json|vitest[^/]*\.ts)$/, full: true, why: "package build or test-harness config" },
  { test: /^(Makefile|Dockerfile|cloudbuild\.yaml|deploy\.sh)$/, full: true, why: "build/deploy entrypoint" },
  { test: /^\.github\/workflows\//, full: true, why: "CI pipeline definition" },

  // Shared code is imported by every surface — narrowing would miss consumers.
  { test: /^packages\/shared\//, full: true, why: "@memex/shared is imported by every package" },
  { test: /^packages\/server\/src\/db\/schema\.ts$/, full: true, why: "schema change ripples through every DB-backed suite" },
  { test: /^packages\/server\/drizzle\//, full: true, why: "migration set" },

  // Targeted surfaces.
  { test: /^packages\/server\/src\/__regression__\//, cmds: ["make test-regression"], why: "regression guards" },
  { test: /^packages\/server\/src\/__security__\//, cmds: ["make test-security"], why: "security suite" },
  { test: /^packages\/server\/src\/__perf__\//, cmds: ["make test-perf"], why: "perf suite" },
  { test: /^packages\/server\/src\/mcp\//, cmds: ["pnpm --filter @memex/server exec vitest run src/mcp", "make test-regression"], why: "MCP surface + its guards" },
  { test: /^packages\/server\/src\/routes\//, cmds: ["make test-api", "make test-regression"], why: "HTTP routes" },
  { test: /^packages\/server\/src\/services\//, cmds: ["make test-integration", "make test-regression"], why: "service layer" },
  { test: /^packages\/server\/src\//, cmds: ["make test-server"], why: "server source" },
  { test: /^packages\/ui\/e2e\//, cmds: ["make e2e-cold"], why: "e2e journeys" },
  { test: /^packages\/ui\/src\//, cmds: ["make test-ui"], why: "UI source" },
  { test: /^packages\/cli\//, cmds: ["pnpm --filter memex-ai test"], why: "CLI package" },
  { test: /^packages\/db-schema\//, cmds: ["pnpm --filter @mindset-ai/db-schema test"], why: "db-schema package" },
  { test: /^packages\/extractor\//, cmds: ["pnpm --filter @memex/extractor test"], why: "extractor package" },
  { test: /^scripts\/ci\//, cmds: ["make check", "make test-regression"], why: "guard scripts + the tests that pin them" },
  { test: /^scripts\//, cmds: ["make check"], why: "repo scripts" },

  // Prose that a guard actually reads. CLAUDE.md is indexed by the standards
  // check and by spec-172's row guard, so it is NOT a no-op change.
  { test: /^CLAUDE\.md$/, cmds: ["make check", "make test-regression"], why: "guards parse this file" },
  { test: /^standards\.manifest\.json$/, cmds: ["make check", "make test-regression"], why: "the standards index is generated from it" },
  { test: /\.md$/, cmds: [], why: "documentation only" },
];

const FULL_MATRIX = [
  "make check",
  "make typecheck",
  "make test-server",
  "make test-ui",
  "make e2e-cold",
];

/** Map changed paths to a plan. Unknown paths ⇒ full matrix, always. */
export function planFor(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      full: true,
      reason: "no changed files were detected — cannot narrow, so run everything",
      commands: FULL_MATRIX,
      unmatched: [],
      matched: [],
    };
  }

  const commands = new Set();
  const matched = [];
  const unmatched = [];
  let full = null;

  for (const file of files) {
    const rule = RULES.find((r) => r.test.test(file));
    if (!rule) {
      unmatched.push(file);
      continue;
    }
    matched.push({ file, why: rule.why });
    if (rule.full) {
      full ??= `${file} (${rule.why})`;
      continue;
    }
    for (const c of rule.cmds) commands.add(c);
  }

  // The load-bearing branch: a path no rule recognises means the map is
  // incomplete, and an incomplete map must fail SAFE (run everything), never
  // quiet (run nothing).
  if (unmatched.length > 0) {
    return {
      full: true,
      reason: `${unmatched.length} path(s) match no rule — the map is incomplete, so nothing is narrowed`,
      commands: FULL_MATRIX,
      unmatched,
      matched,
    };
  }
  if (full) {
    return {
      full: true,
      reason: `a broad-impact path changed: ${full}`,
      commands: FULL_MATRIX,
      unmatched,
      matched,
    };
  }

  return {
    full: false,
    reason: "narrowed from the changed paths",
    commands: [...commands],
    unmatched,
    matched,
  };
}

function changedFiles(base) {
  const mergeBase = execFileSync("git", ["merge-base", "HEAD", base], { encoding: "utf8" }).trim();
  const committed = execFileSync("git", ["diff", "--name-only", `${mergeBase}...HEAD`], { encoding: "utf8" });
  const working = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  return [...new Set([...committed.split("\n"), ...working].map((s) => s.trim()).filter(Boolean))];
}

function main(argv) {
  const json = argv.includes("--json");
  const baseIdx = argv.indexOf("--base");
  const base = baseIdx !== -1 ? argv[baseIdx + 1] : "develop";
  const filesIdx = argv.indexOf("--files");

  let files;
  if (filesIdx !== -1) {
    files = argv.slice(filesIdx + 1).filter((a) => !a.startsWith("--"));
  } else {
    try {
      files = changedFiles(base);
    } catch (err) {
      // Cannot read the diff ⇒ cannot narrow ⇒ run everything, loudly.
      const plan = {
        full: true,
        reason: `could not compute a diff against "${base}": ${String(err.message).split("\n")[0]}`,
        commands: FULL_MATRIX,
        unmatched: [],
        matched: [],
      };
      emit(plan, json, base);
      return 0;
    }
  }

  emit(planFor(files), json, base);
  return 0;
}

function emit(plan, json, base) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...plan, base, advisory: true, ciRunsFullMatrix: true }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Affected tests (vs ${base})\n\n`);
  if (plan.full) {
    process.stdout.write(`  FULL MATRIX — ${plan.reason}\n`);
    if (plan.unmatched.length) {
      process.stdout.write(`  Unrecognised path(s):\n`);
      for (const f of plan.unmatched) process.stdout.write(`    • ${f}\n`);
      process.stdout.write(
        `  Add a rule for these in ${SELF} to narrow future runs.\n`,
      );
    }
  } else {
    process.stdout.write(`  ${plan.matched.length} changed path(s) → ${plan.commands.length} suite(s)\n`);
  }
  process.stdout.write(`\n`);
  for (const c of plan.commands) process.stdout.write(`    ${c}\n`);
  // Printed on EVERY run, narrowed or not — the minimal set is a local
  // starting point and must never read as a merge guarantee.
  process.stdout.write(
    `\n  Advisory: this is the fast local loop, not a gate. ` +
      `CI still runs the full matrix on every PR.\n  Check: ${SELF}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
