// spec-566 t-10 (dec-8, ac-25) — the guard against a detector nobody asked for.
//
// ── What dec-8 decided, and why it is invisible ──
//
// dec-8 chose option D: CLOSE THE SECOND DOOR rather than detect changes. The
// done-gate therefore asks exactly one question — does this Spec hold an
// unaccepted supersession proposal? — and stores no prior statement text, no
// statement hash, and no verification-relative timestamp anywhere on its path.
//
// The problem is that a decision to NOT build something leaves nothing behind.
// A later reader meets a gate that "only" checks for an open proposal, concludes
// it is naive, and adds a diff or a hash FOR SAFETY. That reintroduces the whole
// false-positive class dec-8 was taken to eliminate: a reformatted statement, a
// typo fix, a whitespace change all fire the gate. And every false fire spends
// one of dec-7's overrides — an override used weekly stops being read, which
// collapses dec-7 into the warning-only option it rejected.
//
// ── Why a scan and not a test ──
//
// The claim is the ABSENCE of a mechanism. No passing test can express it: a
// test shows that something DOES happen. Only reading the source can hold "this
// was never built". Same technique as t-1's write-once scan (ac-17).
//
// ── Why this is NOT merged with t-1's scan [per std-51] ──
//
// They share a verb (`readFileSync`) and nothing else. t-1's guards the JOURNAL
// TABLE — no update, no delete, no retention path — and answers to dec-3. This
// guards the GATE MODULE's shape and answers to dec-8. A module holding both
// would be named for the technique rather than the subject, which std-51 names
// as the failure ("`shared`/`utils`/`misc` are not module names"), and a reader
// arriving from either decision would have to skip past the other one's rules.
// Two subjects, two scans.
//
// ── Containment, so the detector cannot simply move one hop away ──
//
// Scanning the gate module alone would be defeated by putting the comparison in
// a helper the gate imports. So the scan ALSO pins the gate's import list: a new
// import is not forbidden, but it cannot pass unnoticed, and the author adding
// one meets this reasoning at the moment they would otherwise route around it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The gate's own module — the whole of the path dec-8 constrains. */
export const GATE_MODULE = "services/done-gate.ts";

export interface DetectorViolation {
  /** The forbidden shape's short name, for the failure message. */
  rule: string;
  line: number;
  text: string;
  /** Why dec-8 excluded this shape specifically. */
  because: string;
}

/**
 * The three shapes dec-8 ruled out, spelled as the code that would implement
 * them rather than as a concept — a scan for "a detector" catches nothing.
 */
const FORBIDDEN: { rule: string; re: RegExp; because: string }[] = [
  {
    rule: "statement hash",
    re: /\bcreateHash\b|\bsha256\b|\bsha1\b|\bmd5\b|statementHash|statement_hash/i,
    because:
      "a hash of the statement is a change detector with extra steps: it fires on a " +
      "reformat and on a typo fix exactly as it fires on a reversal.",
  },
  {
    rule: "prior statement text",
    re: /\b(previous|prior|former|old|last)Statement\b|\bstatementBefore\b|previous_statement|prior_statement/i,
    because:
      "storing what the criterion used to say is the comparison dec-8 declined to " +
      "build. The accept path compares `before` against the live statement, and that " +
      "is a STALENESS check on one proposal — not a gate condition.",
  },
  {
    rule: "verification-relative timestamp",
    re: /statementChangedAt|statement_changed_at|\bverifiedAt\b|verified_at|lastVerifiedAt/i,
    because:
      "'the statement changed after it was verified' is the condition dec-8 replaced. " +
      "It cannot tell a material rewrite from a whitespace edit, which is the " +
      "false-positive class the decision exists to eliminate.",
  },
  {
    rule: "statement comparison",
    // A direct equality test between two statements, in either direction.
    re: /\.statement\s*(===|!==|==|!=)|\bstatement\s*(===|!==)\s*\w+\.statement/,
    because:
      "comparing two statements IS the detector, whatever it is named. The gate's " +
      "only condition is that an unaccepted proposal exists.",
  },
];

/**
 * The imports the gate is known to make. Not a prohibition — a tripwire. A gate
 * that grows a dependency is a gate whose shape changed, and the author should
 * read dec-8 before deciding that is fine.
 */
export const DECLARED_IMPORTS = [
  "drizzle-orm",
  "../db/connection.js",
  "../db/schema.js",
  "../types/errors.js",
  "./lifecycle-journal.js",
  "./mutate.js",
  "./actor.js",
];

/**
 * The rules, over TEXT rather than a path.
 *
 * Exported so a test can hand it a MUTATED copy of the gate without writing to
 * the tree. A scan that never fires guards nothing, and the only way to know it
 * fires is to show it the code it exists to refuse — but a suite that mutated
 * the file it runs in would be a worse cure than the disease.
 *
 * ONE DEFINITION. `scanGateForDetectors` reads the file and delegates here. A
 * second copy of these regexes in the test would keep passing after this one
 * changed, which is the failure mode a guard can least afford.
 */
export function scanSourceForDetectors(text: string): DetectorViolation[] {
  const out: DetectorViolation[] = [];

  text.split("\n").forEach((line, i) => {
    // Comments are where this file EXPLAINS what it does not do, naming every
    // forbidden shape. Scanning them would make the explanation the violation.
    const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    for (const f of FORBIDDEN) {
      if (f.re.test(code)) {
        out.push({ rule: f.rule, line: i + 1, text: line.trim(), because: f.because });
      }
    }
  });

  return out;
}

export function scanGateForDetectors(srcDir: string): DetectorViolation[] {
  return scanSourceForDetectors(readFileSync(join(srcDir, GATE_MODULE), "utf8"));
}

/** A source text's import specifiers. Exported for the same reason as above. */
export function importsOf(text: string): string[] {
  return [...text.matchAll(/^import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]!);
}

/** Imports the gate makes that its declared list does not cover. */
export function scanGateForUndeclaredImports(srcDir: string): string[] {
  return importsOf(readFileSync(join(srcDir, GATE_MODULE), "utf8")).filter(
    (spec) => !DECLARED_IMPORTS.includes(spec),
  );
}

/** The failure text. Its job is to hand the next author dec-8, not to go red. */
export function formatDetectorFailure(violations: DetectorViolation[]): string {
  const lines = [
    `✗ ${violations.length} change-detector shape${violations.length === 1 ? "" : "s"} on the done-gate's path.`,
    "",
    "  spec-566 dec-8 chose to CLOSE THE SECOND DOOR rather than detect changes:",
    "  `update_ac` refuses on a criterion that already reads as satisfied, so a",
    "  meaning change with no proposal is UNREACHABLE. The gate therefore asks one",
    "  question — is there an unaccepted supersession proposal? — and needs nothing",
    "  else to be correct.",
    "",
    "  Adding a detector here does not make the gate safer. It reintroduces the",
    "  false-positive class the decision eliminated: a reformat, a typo fix and a",
    "  whitespace edit all fire it. Every false fire spends one of dec-7's",
    "  overrides, and an override used weekly stops being read — which collapses",
    "  dec-7 into the warning-only option it explicitly rejected.",
    "",
  ];
  for (const v of violations) {
    lines.push(`  ${GATE_MODULE}:${v.line} — ${v.rule}`);
    lines.push(`    ${v.text}`);
    lines.push(`    ${v.because}`);
    lines.push("");
  }
  lines.push(
    "  If the gate genuinely needs a new condition, change dec-8 first and say so",
    "  there. Do not widen this scan to let the code through.",
  );
  return lines.join("\n");
}
