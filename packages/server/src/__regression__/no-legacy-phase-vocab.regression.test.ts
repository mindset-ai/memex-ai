// spec-181 (dec-1 / dec-2) — the `plan` → `specify` phase-rename done-definition guard.
//
// spec-181 renamed the SECOND Spec-pipeline phase `plan` → `specify`. The forward
// pipeline is now `draft → specify → build → verify → done`. This regression test
// is the CI tripwire that stops a phase-sense `plan` from creeping back in.
//
// ── Why this can't be a bare `\bplan\b` scan ─────────────────────────────────
// Unlike its sibling `no-legacy-spec-vocab.regression.test.ts` (b-105 / dec-10),
// the token `plan` is NOT retired. It survives, legitimately, in three unrelated
// vocabularies that this guard must NOT touch:
//   1. the `plan` COMMENT TYPE and `plan_revision` (roles.ts CommentType / COMMENT_TYPES,
//      the doc_comments CHECK, UI commentStyles / CommentTray),
//   2. the `execution_plan` DOC TYPE (roles.ts DocType / DOC_TYPES, refs, UI),
//   3. ordinary English ("planning", "the plan", "execution plans").
// A bare word-boundary scan would drown in false positives. So instead of a broad
// token match + huge allowlist, this guard uses SENSE-ANCHORED patterns: it only
// fires when `plan` is used as a PHASE value / pipeline member / phase block-id /
// phase display-map entry. That design choice keeps the allowlist tiny — only the
// handful of sites that legitimately NAME the retired phase value (the migration's
// own explainer + the tests that assert the value is now rejected) need allowlisting.
//
// ── What "phase-sense" means here (ac-11 enumerates these) ───────────────────
//   (a) phase-field literals     — status/target/phase/transition (+ *_phase /
//                                   *_transition / statusIn / CHECK IN-lists) = 'plan'
//   (b) pipeline runs            — `plan` adjacent to a phase sibling
//                                   (draft|build|verify|done) via / → -> , and the
//                                   arrow forms `plan→build`, `draft→plan`, `Phase: plan`
//   (c) scaffold block ids       — `phase-plan-` prefix
//   (d) guidance phase prose     — a phase-sibling pipeline run inside guidance JSON
//                                   (`plan_revision` is a different vocab, never matched)
//   (e) phaseDisplay map entry   — the old `plan: 'Specify'` shim
//   plus phase-sibling union members (`| 'plan'` where the union carries draft/build/verify)
//   and `case 'plan':` switch arms.
//
// Red CI = phase-rename drift. The fix is to rename the offending source to
// `specify` — adding to the allowlist is only correct for a site that legitimately
// NAMES the retired value (migration explainer / a test asserting rejection /
// immutable migration SQL). The comment-type / docType / execution-plan / plain-English
// `plan` senses are NOT matched by any pattern here and so never need allowlisting.

import { describe, expect, it } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";

// ---- constants ------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// packages/server/src/__regression__/<this file> → repo root is 4 levels up.
const REPO_ROOT = resolve(__dirname, "../../../..");

// Same extension set as the spec-vocab guard. Binaries, lockfiles, generated
// `.snap` files are skipped.
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".md", ".json", ".sql", ".sh"]);

// We scan packages/** only (the rename lives entirely in code/guidance/UI; the
// task scopes this guard to packages/**). Historical Drizzle migrations are
// excluded (immutable, name both ends of every rename) — but we positively
// assert the NEW 0078 migration exists (see the ac-15 block).
const SCAN_DIRS = ["packages"];

const EXCLUDE_DIR_NAMES = new Set([
  ".git",
  ".github",
  ".claude",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".logs",
  ".turbo",
  ".pnpm",
  "worktrees",
  // Immutable migration history: every Drizzle migration is frozen and names
  // both ends of each rename (0078 carries `plan` ↔ `specify` on purpose).
  "drizzle",
]);

const EXCLUDE_FILE_SUFFIXES = [".snap"];

// ---- sense-anchored phase patterns (ac-11) --------------------------------
//
// Each entry is a NON-global regex tested per line. `plan` is matched with a
// trailing word boundary (`plan\b`) so `planAgent`, `plan_revision`,
// `planning`, `execution_plan` never trip a pattern (the char after `plan`
// there is a word char, so `\b` fails).

const PHASE_PATTERNS: { name: string; re: RegExp }[] = [
  // (a) phase-field = 'plan' — status/target/phase/transition + *_phase /
  //     *_transition / statusIn, with `:` `=` or SQL `IN (` between the field
  //     and the quoted value, allowing array/list brackets in between.
  {
    name: "phase-field literal",
    re: /(?:\bstatus\b|\bstatusIn\b|\btarget\b|\bphase\b|\btransition\b|\btarget_phase\b|\btarget_transition\b|\btargetPhase\b|\btargetTransition\b)\s*(?::|=|\bIN\b)\s*[[(]?[^)\]]*['"]plan['"]/,
  },
  // (a) SQL CHECK / IN list naming target_phase/target_transition with 'plan'.
  {
    name: "phase CHECK list",
    re: /(?:target_phase|target_transition)\b[^]*?['"]plan['"]/,
  },
  // (b) pipeline runs — `plan` next to a phase sibling via separators / → -> ,
  {
    name: "pipeline run (plan beside a phase sibling)",
    re: /(?:\b(?:draft|build|verify|done)\b\s*(?:\/|→|->|—>|,)\s*plan\b|\bplan\b\s*(?:\/|→|->|—>|,)\s*\b(?:draft|build|verify|done)\b)/,
  },
  // (b) explicit phase claims — `Phase: plan`, `phase is now 'plan'`.
  {
    name: "phase claim",
    re: /(?:\bPhase:\s*['"]?plan\b|\bphase\b[^]{0,20}\bis now\b[^]{0,6}['"]?plan\b)/i,
  },
  // (c) scaffold block ids — `phase-plan-` prefix.
  { name: "scaffold phase block id", re: /phase-plan-/ },
  // (d) phaseDisplay shim — `plan: 'Specify'` / `plan: "Specify"`.
  { name: "phaseDisplay shim", re: /\bplan\s*:\s*['"]Specify['"]/ },
  // phase-sibling union member — `| 'plan'` / `'plan' |` ONLY when the same
  // line carries a phase sibling (so the comment-type / docType unions, whose
  // siblings are `discussion`/`progress`/`execution_plan`, never match).
  {
    name: "phase union member",
    re: /(?:\|\s*['"]plan['"]|['"]plan['"]\s*\|)/,
  },
  // `case 'plan':` switch arm.
  { name: "case label", re: /\bcase\s+['"]plan['"]\s*:/ },
];

// The union-member pattern needs a second condition (line also names a phase
// sibling) to avoid the comment-type unions. We apply it in `lineHits`.
const PHASE_SIBLING_RE = /\b(?:draft|build|verify|specify)\b/;

function lineHits(body: string): string[] {
  const names: string[] = [];
  for (const { name, re } of PHASE_PATTERNS) {
    if (!re.test(body)) continue;
    if (name === "phase union member" && !PHASE_SIBLING_RE.test(body)) {
      // `| 'plan'` inside a CommentType / DocType union (siblings are
      // discussion/progress/execution_plan) — not phase-sense. Skip.
      continue;
    }
    names.push(name);
  }
  return names;
}

// A cheap whole-file pre-filter: if `plan` (word-bounded trailing) never
// appears, no line can match.
const FILE_PREFILTER_RE = /plan\b/;

// ---- allowlist ------------------------------------------------------------
//
// These sites legitimately NAME the retired `plan` phase value because their
// whole job is to explain or assert the rename. Every entry is justified.
// Anything matching outside this set is drift — rename it to `specify`.
//
// Forms:
//   { file }            — whole file allowlisted
//   { file, pattern }   — only lines matching `pattern` (in that file) allowlisted

type AllowEntry = { file: string; pattern?: RegExp };

const ALLOWLIST: AllowEntry[] = [
  // This guard itself names every retired pattern in its prose + patterns.
  { file: "packages/server/src/__regression__/no-legacy-phase-vocab.regression.test.ts" },

  // The dedicated spec-181 migration tests: their entire purpose is to assert
  // that the retired `plan` phase value is now rejected. They name `plan`
  // throughout (status:"plan", target:"plan", CHECK rejects 'plan', etc.).
  { file: "packages/server/src/mcp/plan-to-specify-migration.integration.test.ts" },
  { file: "packages/server/src/db/spec-181-plan-to-specify-migration.test.ts" },
  { file: "packages/server/src/types/plan-to-specify-unions.test.ts" },

  // The structured-error explainer (migration-map.ts) + its call site (app.ts):
  // these legitimately NAME the old value to tell a caller it was renamed. The
  // message itself says "draft → specify → build → verify → done".
  { file: "packages/server/src/mcp/migration-map.ts" },
  { file: "packages/server/src/app.ts", pattern: /phase-sense status\/target of "plan"/ },

  // roles.test.ts: a historical-lineage assertion comment ("plan→build→verify,
  // then spec-181 renamed the second phase plan→specify"). It documents the
  // rename chain — the value is named on purpose.
  {
    file: "packages/server/src/types/roles.test.ts",
    pattern: /plan→build→verify|second phase plan→specify/,
  },
];

function isAllowlisted(relPath: string, body: string): boolean {
  for (const e of ALLOWLIST) {
    if (e.file !== relPath) continue;
    if (!e.pattern) return true;
    if (e.pattern.test(body)) return true;
  }
  return false;
}

// ---- file walker ----------------------------------------------------------

function shouldScanFile(name: string): boolean {
  for (const suffix of EXCLUDE_FILE_SUFFIXES) {
    if (name.endsWith(suffix)) return false;
  }
  return SCAN_EXTENSIONS.has(extname(name));
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!s.isFile()) continue;
    if (shouldScanFile(entry)) yield full;
  }
}

function* collectInScopeFiles(): Generator<string> {
  for (const sub of SCAN_DIRS) {
    yield* walk(resolve(REPO_ROOT, sub));
  }
}

// ---- scanner --------------------------------------------------------------

interface Hit {
  path: string;
  line: number;
  body: string;
  pattern: string;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const fullPath of collectInScopeFiles()) {
    const relPath = relative(REPO_ROOT, fullPath);
    let content;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    if (!FILE_PREFILTER_RE.test(content)) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const body = lines[i];
      const matched = lineHits(body);
      if (matched.length === 0) continue;
      if (isAllowlisted(relPath, body)) continue;
      hits.push({ path: relPath, line: i + 1, body, pattern: matched.join(", ") });
    }
  }
  return hits;
}

// ---- tests ----------------------------------------------------------------

describe("regression: no legacy phase vocab — `plan` → `specify` (spec-181)", () => {
  it("packages/** carries no phase-sense `plan` outside the allowlist", () => {
    // ac-11: zero phase-sense `plan` survivors (sense-anchored, not bare \\bplan\\b).
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-11");
    // ac-1 (scope): zero phase-sense legacy survivors across packages/** IS the
    // mechanical core of "specify is canonical at every surface".
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-1");
    const hits = scan();
    if (hits.length > 0) {
      const lines = hits.map(
        (h) => `  ${h.path}:${h.line}  [${h.pattern}]\n      ${h.body.trim()}`,
      );
      const msg =
        `Found ${hits.length} phase-sense 'plan' hit(s) — the second pipeline phase is now\n` +
        `'specify' (pipeline: draft → specify → build → verify → done). Rename each to\n` +
        `'specify'. Only allowlist a site that legitimately NAMES the retired value to\n` +
        `explain/assert the rename (migration explainer or a rejection test).\n\n` +
        lines.join("\n");
      throw new Error(msg);
    }
    expect(hits).toEqual([]);
  });

  it("preserves the non-phase `plan` senses + new phase vocab (ac-15)", () => {
    // ac-15: the rename must NOT collateral-damage the comment-type / docType /
    //        execution-plan vocabularies, and the new `specify` vocab must be wired.
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-15");
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-5");

    const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), "utf8");

    // 1. roles.ts CommentType union + COMMENT_TYPES still carry the `plan`
    //    comment type AND `plan_revision`.
    const roles = read("packages/server/src/types/roles.ts");
    expect(roles).toMatch(/CommentType\b[^]*?\|\s*"plan"/);
    expect(roles).toMatch(/"plan_revision"/);
    expect(roles).toMatch(/COMMENT_TYPES[^]*?"plan"[^]*?"plan_revision"/);
    // 2. roles.ts DocType + DOC_TYPES still carry execution_plan.
    expect(roles).toMatch(/DocType\b[^]*?"execution_plan"/);
    expect(roles).toMatch(/DOC_TYPES[^]*?"execution_plan"/);
    // ...and the renamed phase vocab is present, the retired one is gone.
    expect(roles).toMatch(/SpecStatus\b[^]*?"specify"/);
    expect(roles).not.toMatch(/SpecStatus\s*=\s*"draft"\s*\|\s*"plan"/);

    // 3. doc_comments comment-type CHECK still contains 'plan' and 'plan_revision'.
    const schema = read("packages/server/src/db/schema.ts");
    expect(schema).toMatch(
      /commentType[^]*?IN \([^)]*'plan'[^)]*'plan_revision'[^)]*\)/,
    );
    // ...and the scaffold target_phase / target_transition CHECKs are on 'specify'.
    expect(schema).toMatch(/target_phase_valid[^]*?'specify'/);
    expect(schema).toMatch(/target_transition_valid[^]*?'specify'/);

    // 4. scaffold-data.ts still carries `plan_revision` prose.
    const scaffold = read("packages/shared/src/scaffold-data.ts");
    expect(scaffold).toMatch(/plan_revision/);

    // 5. The new 0078 migration exists (immutable-history exclusion still lets
    //    us positively assert its presence — ac-15 deploy-readiness).
    expect(
      existsSync(resolve(REPO_ROOT, "packages/server/drizzle/0078_plan_to_specify.sql")),
    ).toBe(true);
  });

  it("ref grammar has no phase segment — refs stay /<ns>/<memex>/specs/spec-N (ac-7)", () => {
    // ac-7 re-verification: the canonical ref grammar is docType-keyed, never
    // phase-keyed. There must be no `/plan/` or `/specify/` PATH SEGMENT in the
    // ref grammar — phases are not part of a ref.
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-7");
    const refs = readFileSync(
      resolve(REPO_ROOT, "packages/server/src/services/refs.ts"),
      "utf8",
    );
    // The DocType path-segment union is {specs, docs, standards, execution-plans}
    // (+ issues/clauses children) — assert specs is present and no phase segment.
    expect(refs).toMatch(/"specs"/);
    expect(refs).not.toMatch(/['"]plan['"]\s*[,|]|\/plan\//);
    expect(refs).not.toMatch(/['"]specify['"]|\/specify\//);
  });

  // Sentinel: prove the scanner actually catches a freshly-introduced phase-sense
  // `plan`. We drop a temp file inside the scanned tree, assert it's flagged, and
  // always clean up (so a crashed run never poisons the next run's main test).
  it("flags a sentinel file containing a seeded phase-sense `plan`", () => {
    const sentinelDir = resolve(
      REPO_ROOT,
      "packages/server/src/__regression__/__phase_sentinel_tmp__",
    );
    try {
      mkdirSync(sentinelDir, { recursive: true });
      const sentinelPath = join(sentinelDir, "sentinel.ts");
      // A clear phase-sense use: a status literal set to the retired value.
      writeFileSync(
        sentinelPath,
        'export const seeded = { status: "plan" }; // draft / plan / build\n',
      );

      const hits = scan();
      const relSentinel = relative(REPO_ROOT, sentinelPath);
      const flagged = hits.find((h) => h.path === relSentinel);
      expect(
        flagged,
        `scanner did not flag the seeded phase-sense 'plan' at ${relSentinel}`,
      ).toBeDefined();
    } finally {
      rmSync(sentinelDir, { recursive: true, force: true });
    }
  });
});
