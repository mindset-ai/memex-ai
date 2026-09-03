// Static companion to guidance-sole-author.integration.test.ts.
//
// THE INVARIANT (call-graph form): composeGuidanceEnvelope is the sole author of
// footer prose. The "prose builders" below produce footer words; after spec-219
// Phase 2 they may be CALLED only from `renderFooterSignal` (the signal→words
// mapper that composeGuidanceEnvelope owns). A reference anywhere else means a
// handler reached for the words directly — exactly what we forbid. This fails at
// author-time (no DB, no dispatch), the instant someone re-scatters a nudge.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AC_PRESENCE = "mindset-prod/memex-building-itself/specs/spec-548/acs/ac-1";
const AC_MESSAGE = "mindset-prod/memex-building-itself/specs/spec-548/acs/ac-2";
const AC_LIST_FLOOR = "mindset-prod/memex-building-itself/specs/spec-548/acs/ac-3";
const AC_FACADE_CORPUS = "mindset-prod/memex-building-itself/specs/spec-548/acs/ac-6";
const AC_WINDOW = "mindset-prod/memex-building-itself/specs/spec-548/acs/ac-8";
const AC_FACADE_CLOSED = "mindset-prod/memex-building-itself/specs/spec-548/acs/ac-7";
// Scope ACs, verified by the same evidence as the implementation ACs beneath them —
// one test may carry both, and leaving an outcome commitment untested when its proof
// already runs is exactly the silent gap this Spec is about.
const AC_SCOPE_GUARD_LOOKS = "mindset-prod/memex-building-itself/specs/spec-548/acs/ac-10";
const AC_SCOPE_WHOLE_VIEW = "mindset-prod/memex-building-itself/specs/spec-548/acs/ac-12";

// spec-366 / spec-546: renderFooterSignal + composeGuidanceEnvelope (the sole
// footer-prose authors) live together in ONE module under agent/handlers/; the
// per-tool handlers live in agent/handlers/*.ts. Concatenate every handler module
// so any handler that reaches for a prose builder directly is flagged as an
// offender outside the confinement window.
//
// spec-546: this used to read shared.ts by name FIRST, so the window's two
// anchors would appear in order. That is no longer needed — both anchors live in
// the same file, so their order is preserved by the file itself whatever order
// the directory is read in. Sorted for determinism: readdirSync order is
// filesystem-dependent, and this guard's window is computed from positions.
const HANDLERS_DIR = join(__dirname, "..", "agent", "handlers");
const HANDLERS_SRC = readdirSync(HANDLERS_DIR)
  .filter((n) => n.endsWith(".ts"))
  .sort()
  .map((n) => readFileSync(join(HANDLERS_DIR, n), "utf-8"))
  .join("\n");

// spec-548 dec-3: the corpus is the handlers PLUS the tool façade. Reading only
// agent/handlers/ left a hole the per-entry presence check cannot close: it catches a
// builder that VANISHES, never one newly authored in agent/tool-specs.ts, which is
// absent from PROSE_BUILDERS and from the scanned source alike. Appended AFTER the
// handlers so the confinement window — computed from positions in SRC — stays inside
// the handlers portion and every façade byte falls outside it (ac-8).
const FACADE_PATH = join(__dirname, "..", "agent", "tool-specs.ts");
const FACADE_OFFSET = HANDLERS_SRC.length + 1; // +1 for the joining newline
const SRC = `${HANDLERS_SRC}\n${readFileSync(FACADE_PATH, "utf-8")}`;

// renderFooterSignal's body spans from its header to the next top-level function
// (composeGuidanceEnvelope, which we place immediately after it). Span by anchor,
// not brace-matching — the prose templates contain `{ }` that would fool a
// counter.
const RFS_START = SRC.indexOf("async function renderFooterSignal(");
const RFS_END = SRC.indexOf("export async function composeGuidanceEnvelope(", RFS_START);

it("sanity: renderFooterSignal precedes composeGuidanceEnvelope", () => {
  tagAc(AC_WINDOW);
  expect(RFS_START).toBeGreaterThan(-1);
  expect(RFS_END).toBeGreaterThan(RFS_START);
  // spec-548 ac-8: the window must live wholly in the handlers portion, so that a
  // prose reference in the façade is an OFFENDER rather than a licensed use.
  expect(RFS_END).toBeLessThanOrEqual(FACADE_OFFSET);
  expect(FACADE_OFFSET).toBeLessThan(SRC.length);
});

// Each builder: the call token to hunt, and the regex that recognises its OWN
// definition/import line (allowed to live outside renderFooterSignal).
const PROSE_BUILDERS: { call: string; defLine: RegExp }[] = [
  { call: "COMPLETION_NUDGE", defLine: /export const COMPLETION_NUDGE/ },
  { call: "buildSketchBlock(", defLine: /import .*buildSketchBlock/ },
  { call: "relatedIssuesNudge(", defLine: /export function relatedIssuesNudge/ },
];

// spec-548 ac-2: a guard that fails without naming the rotten entry costs its reader
// a grep. Extracted so the wording itself can be asserted — per std-51, extracting for
// testability earns its keep when the fault lives in the extracted part, and a message
// that fails to name the entry is a fault of the message, not of the wiring.
// Deliberately names no directory: the corpus widens in dec-3 and this text should not
// have to be revised when it does.
function missingBuilderMessage(call: string): string {
  return (
    `${call} is listed in PROSE_BUILDERS but occurs NOWHERE in the scanned corpus. ` +
    `The confinement check for it therefore inspected nothing and would have passed ` +
    `no matter what the code did. Either remove the entry from PROSE_BUILDERS, or ` +
    `follow the builder to its new location and extend the corpus to reach it.`
  );
}

describe("the guard's own list is intact", () => {
  // spec-548 ac-3. Not redundant with the per-entry check below: the `for` loop
  // registers ZERO `it()` cases on an empty list, and the standalone sanity test above
  // keeps the FILE green, so an emptied list would report success having run nothing.
  it("PROSE_BUILDERS is not empty — an emptied list would register no cases at all", () => {
    tagAc(AC_LIST_FLOOR);
    expect(
      PROSE_BUILDERS.length,
      "PROSE_BUILDERS has been emptied or refactored away; the per-builder checks below no longer exist",
    ).toBeGreaterThanOrEqual(3);
  });

  // spec-548 ac-2.
  it("the missing-entry message names the entry and both legitimate fixes", () => {
    tagAc(AC_MESSAGE);
    const msg = missingBuilderMessage("someVanishedBuilder(");
    expect(msg).toContain("someVanishedBuilder(");
    expect(msg).toMatch(/remove the entry/i);
    expect(msg).toMatch(/follow the builder/i);
  });
});

// The offender scan, lifted out of the per-builder case so spec-548 ac-6 can assert it
// against a synthetic corpus. Per std-51 this extraction earns its keep: the fault a
// widened corpus could introduce lives in this arithmetic (window bounds vs. absolute
// offsets), not in the wiring — and the ONE live offender the widening surfaces is
// removed by dec-3 itself, so a test that relied on it would evaporate.
function findOffenders(
  src: string,
  winStart: number,
  winEnd: number,
  call: string,
  defLine: RegExp,
): number[] {
  const offenders: number[] = [];
  let idx = src.indexOf(call);
  while (idx !== -1) {
    const withinRenderer = idx >= winStart && idx < winEnd;
    const lineStart = src.lastIndexOf("\n", idx) + 1;
    const lineEndRaw = src.indexOf("\n", idx);
    const lineEnd = lineEndRaw === -1 ? src.length : lineEndRaw;
    const line = src.slice(lineStart, lineEnd);
    const isOwnDecl = defLine.test(line);
    if (!withinRenderer && !isOwnDecl) {
      offenders.push(src.slice(0, idx).split("\n").length); // 1-based line no.
    }
    idx = src.indexOf(call, idx + 1);
  }
  return offenders;
}

describe("the corpus reaches the façade", () => {
  // spec-548 ac-6.
  it("a prose reference in the appended façade portion is reported as an offender", () => {
    tagAc(AC_FACADE_CORPUS);
    tagAc(AC_SCOPE_WHOLE_VIEW);
    const handlers = ["line one", "async function renderFooterSignal(", "  SOME_NUDGE", "}"].join("\n");
    const facade = ["export { SOME_NUDGE } from './handlers/x.js';"].join("\n");
    const src = `${handlers}\n${facade}`;
    const winStart = src.indexOf("async function renderFooterSignal(");
    const winEnd = src.indexOf("}", winStart);

    // Inside the window: licensed, no offender.
    expect(findOffenders(src, winStart, winEnd, "SOME_NUDGE", /never-matches/)).toEqual([5]);
    // …and line 5 IS the façade line, so the scan reaches past the handlers portion
    // and reports the source line rather than merely noticing something.
    expect(src.split("\n")[4]).toContain("export { SOME_NUDGE }");
  });

  // spec-548 ac-7. The corpus reaching the façade is only half of dec-3; the other
  // half is that the façade stops handing the prose out. Without this, nothing stops
  // the re-exports being restored — and a restored re-export is invisible to the
  // confinement check, because a re-export line is not a "use".
  it("the façade does not republish the prose builders", () => {
    tagAc(AC_FACADE_CLOSED);
    tagAc(AC_SCOPE_WHOLE_VIEW);
    const facade = readFileSync(FACADE_PATH, "utf-8");
    const code = facade
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    for (const token of ["COMPLETION_NUDGE", "relatedIssuesNudge"]) {
      expect(
        code,
        `${token} is re-exported from agent/tool-specs.ts again. Its only consumers were tests; ` +
          `a re-export line is not a "use", so the confinement check cannot see it (spec-548 dec-3).`,
      ).not.toContain(token);
    }
  });

  // spec-548 ac-7, the consumer half.
  it("the four former façade consumers import from the handler modules", () => {
    tagAc(AC_FACADE_CLOSED);
    tagAc(AC_SCOPE_WHOLE_VIEW);
    const SERVER_SRC = join(__dirname, "..");
    const consumers: [string, string][] = [
      ["agent/decision-related-issues.integration.test.ts", "handlers/related-issues.js"],
      ["services/spec-219-footer-slot.integration.test.ts", "handlers/guidance-envelope.js"],
      ["services/spec-219-transition-keyed.integration.test.ts", "handlers/guidance-envelope.js"],
      ["mcp/workflows.integration.test.ts", "handlers/guidance-envelope.js"],
    ];
    for (const [rel, expectedFrom] of consumers) {
      // readFileSync throws if the file is renamed away — this corpus cannot go
      // silently empty, so it needs no separate non-vacuity floor (dec-2).
      const text = readFileSync(join(SERVER_SRC, rel), "utf-8");
      const importLine = text
        .split("\n")
        .find((l) => /^import .*(COMPLETION_NUDGE|relatedIssuesNudge)/.test(l));
      expect(importLine, `${rel} no longer imports either prose builder at all`).toBeDefined();
      expect(importLine, `${rel} should reach the builder through ${expectedFrom}`).toContain(
        expectedFrom,
      );
    }
  });

  it("the real façade file is actually part of SRC", () => {
    tagAc(AC_FACADE_CORPUS);
    tagAc(AC_SCOPE_WHOLE_VIEW);
    expect(SRC.length).toBeGreaterThan(FACADE_OFFSET);
    expect(SRC.slice(FACADE_OFFSET)).toContain("tools");
  });
});

describe("footer prose builders are confined to renderFooterSignal", () => {
  for (const { call, defLine } of PROSE_BUILDERS) {
    it(`${call} is referenced only inside renderFooterSignal (or its own def/import)`, () => {
      tagAc(AC_PRESENCE);
      tagAc(AC_SCOPE_GUARD_LOOKS);
      // spec-548 ac-1 — the loop below is vacuous for a token that isn't there:
      // indexOf returns -1, the body never runs, `offenders` stays [], and the
      // assertion passes. "Found it, all confined" and "never found it" were
      // indistinguishable from outside until this line.
      expect(SRC.indexOf(call), missingBuilderMessage(call)).toBeGreaterThan(-1);

      const offenders = findOffenders(SRC, RFS_START, RFS_END, call, defLine);
      expect(
        offenders,
        `${call} is used outside renderFooterSignal at handlers source line(s) ${offenders.join(", ")} — guidance prose must be authored only in composeGuidanceEnvelope/renderFooterSignal`,
      ).toEqual([]);
    });
  }
});
