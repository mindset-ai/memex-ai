// spec-542 t-4 (ac-13, ac-7) — the server derives the grounding state from the
// doc and hands it to BOTH toNudge call sites.
//
// t-3 fixed the projection: given a state, the Scaffold selects the right prose.
// Nothing produced that state yet. This closes the wiring, at the two places in
// formatters.ts that compose the nudge:
//
//   :~1631  renderSpecPhaseGuidance  — the EMISSION
//   :~191   estimateEnvelopeChars    — the response-BUDGET measurement
//
// The second is the one easily missed, and missing it is a real defect rather
// than an omission: the estimate would size the envelope from a string that is
// never emitted. That function's own comment forbids it — "a COMPUTATION over
// the same projection the seat will use, not a guess about it [per std-50 cl-1]".
// Hence the structural assertion below as well as the behavioural ones: only a
// source-level check can see that BOTH sites were wired.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatSpecGuidance } from "./formatters.js";
import type { Doc, DocSection } from "../db/schema.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-542/acs/ac-${n}`;

const formattersSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "formatters.ts"),
  "utf-8",
);

/**
 * The source with comment lines removed.
 *
 * A first version of the call-site assertion below counted 4 `toNudge({...})`
 * matches instead of 2: two real call sites plus two doc-comments that QUOTE
 * the call shape. Counting prose as code is the kind of structural assertion
 * that passes or fails for reasons unrelated to the code, so comments go first.
 */
const formattersCode = formattersSrc
  .split("\n")
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

const baseDate = new Date("2026-01-01T00:00:00Z");

// `groundedStale` is DERIVED, not a column, so it is not on `Doc`. It rides the
// enriched object `getDoc` returns, which is what reaches the footer seat
// (fullDocState → getDoc). The fixture mirrors that shape.
function makeSpecDoc(
  overrides: Partial<Doc> & { groundedStale?: boolean } = {},
): Doc & { sections: DocSection[]; groundedStale?: boolean } {
  return {
    id: "spec-uuid-542",
    memexId: "memex-building-itself",
    handle: "spec-542",
    title: "Grounding state spec",
    docType: "spec",
    description: null,
    skillCapabilities: null,
    status: "specify",
    parentDocId: null,
    createdByUserId: null,
    createdAt: baseDate,
    statusChangedAt: baseDate,
    archivedAt: null,
    archiveReason: null,
    archivedByUserId: null,
    archivedByName: null,
    supersededByDocId: null,
    supersededAt: null,
    supersessionNote: null,
    narrativeLastConsolidatedAt: null,
    isDemo: false,
    groundedInCode: false,
    groundedAt: null,
    groundedByUserId: null,
    groundedByName: null,
    sensitive: false,
    sensitiveByUserId: null,
    sensitiveByName: null,
    checkedOutBy: null,
    checkedOutAt: null,
    checkedOutThread: null,
    version: 1,
    ...overrides,
    sections: [
      {
        id: "s-uuid-1",
        docId: "spec-uuid-542",
        sectionType: "overview",
        title: "Overview",
        description: null,
        content: "Body.",
        seq: 1,
        createdAt: baseDate,
        updatedAt: baseDate,
      } as DocSection,
    ],
  } as Doc & { sections: DocSection[]; groundedStale?: boolean };
}

const NEGATIVE = /No code-grounding on this Spec/;
const AFFIRMATIVE = /Code-grounding affirmed by agent/;
const STALE = /Treat the grounding as out of date/;

const guidanceFor = (o: Partial<Doc> & { groundedStale?: boolean }) =>
  formatSpecGuidance(makeSpecDoc(o), [], []);

describe("spec-542 — the footer reports the state the document actually holds", () => {
  it("an UNGROUNDED Spec is told so", () => {
    tagAc(AC(13));

    const out = guidanceFor({ groundedInCode: false });
    expect(out).toMatch(NEGATIVE);
    expect(out).not.toMatch(AFFIRMATIVE);
  });

  it("a GROUNDED Spec is no longer told the opposite", () => {
    tagAc(AC(13));

    // The reported defect, at the server seat rather than in the projection.
    const out = guidanceFor({
      groundedInCode: true,
      groundedAt: baseDate,
      groundedByName: "someone",
      groundedStale: false,
    });
    expect(out, "a grounded Spec is still being told it has no grounding").not.toMatch(
      NEGATIVE,
    );
    expect(out).toMatch(AFFIRMATIVE);
  });

  it("a STALE-grounded Spec is told to re-check, not that grounding is absent", () => {
    tagAc(AC(13));

    const out = guidanceFor({
      groundedInCode: true,
      groundedAt: baseDate,
      groundedStale: true,
    });
    expect(out).toMatch(STALE);
    expect(out).not.toMatch(AFFIRMATIVE);
    expect(out).not.toMatch(NEGATIVE);
  });

  it("grounded-but-staleness-UNKNOWN asserts nothing about grounding", () => {
    tagAc(AC(7));

    // `groundedStale` is optional on the shape the formatter accepts, so it CAN
    // be absent. Rendering "grounded" then would assert freshness nobody
    // checked — a silent default, which std-50 forbids and which is this Spec's
    // whole defect class. So: no claim. On the real path (fullDocState → getDoc)
    // the flag is always derived, making this a defensive branch, not an
    // expected one — pinned so it cannot quietly become a default later.
    const out = guidanceFor({ groundedInCode: true, groundedAt: baseDate });
    expect(out).not.toMatch(NEGATIVE);
    expect(out).not.toMatch(AFFIRMATIVE);
    expect(out).not.toMatch(STALE);
  });

  it("the state-independent ask survives in every case", () => {
    tagAc(AC(13));

    // Splitting the block must not cost the specify→build gate prompt.
    for (const o of [
      { groundedInCode: false },
      { groundedInCode: true, groundedAt: baseDate, groundedStale: false },
      { groundedInCode: true, groundedAt: baseDate, groundedStale: true },
    ]) {
      expect(guidanceFor(o)).toMatch(/Call assess_spec again with `codeGrounding`/);
    }
  });
});

describe("spec-542 — BOTH toNudge call sites receive the state (ac-13)", () => {
  it("every toNudge call in formatters.ts passes `grounding`", () => {
    tagAc(AC(13));

    // Structural by necessity: `estimateEnvelopeChars` is private and its
    // effect is a size, not text, so no behavioural assertion can see whether
    // it was wired. A state passed at only one site would silently mis-size the
    // envelope for every Spec read — the exact "measure one thing, emit
    // another" defect std-50 cl-1 names.
    const calls = formattersCode.match(/toNudge\(\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length, "expected both toNudge call sites").toBe(2);
    for (const call of calls) {
      expect(call, `a toNudge call site does not pass grounding:\n${call}`).toMatch(
        /grounding[,:]/,
      );
    }
  });

  it("the state is derived by ONE helper, not re-derived per call site", () => {
    tagAc(AC(13));

    // Two independent derivations are how the emission and the estimate drift
    // apart. One definition, called from both.
    const defs = formattersCode.match(/function groundingStateOf/g) ?? [];
    expect(defs.length, "groundingStateOf must be defined exactly once").toBe(1);
    expect(formattersCode.match(/groundingStateOf\(/g)?.length ?? 0).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("no grounding prose is written in server/src — it all comes from the Scaffold", () => {
    tagAc(AC(8));

    // std-15: the prose has one home. A replacement sentence written here would
    // also trip the scaffold drift-guard, since this file is not on its
    // allowlist. Asserted directly so the intent is visible, not just enforced
    // elsewhere by a guard whose failure would be read as unrelated.
    expect(formattersSrc).not.toMatch(NEGATIVE);
    expect(formattersSrc).not.toMatch(AFFIRMATIVE);
    expect(formattersSrc).not.toMatch(STALE);
  });
});
