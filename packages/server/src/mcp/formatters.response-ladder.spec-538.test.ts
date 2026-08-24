// spec-538 t-3 — the three-tier response ladder, and the line that says which
// tier you got.
//
// The defect: a mature Spec renders past what the MCP client accepts, so the
// client writes the payload to a file and hands the agent a path. Nothing placed
// inside an overflowing payload reaches the reader — position is not the
// variable, size is. dec-4's answer is a ladder, and ac-13 is the property that
// keeps it honest: three shapes with no self-description would trade a silent
// overflow for a silent truncation.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatFullDocState } from "./formatters.js";
import { RESPONSE_BODY_BUDGET_CHARS } from "./response-budget.js";
import type { Doc, DocSection, Decision } from "../db/schema.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

const baseDate = new Date("2026-03-25T12:00:00Z");

function makeSection(seq: number, content: string): DocSection {
  return {
    id: `section-uuid-${seq}`,
    docId: "doc-uuid-1",
    sectionType: seq === 1 ? "overview" : `lens-${seq}`,
    title: seq === 1 ? "Overview" : `Lens ${seq}`,
    description: null,
    content,
    seq,
    preamble: null,
    position: seq,
    status: "active",
    previousStatus: null,
    retiredAtVersion: null,
    createdAt: baseDate,
    updatedAt: baseDate,
    actorUserId: null,
    actorName: null,
    channel: null,
  } as DocSection;
}

function makeDecision(seq: number, resolutionChars: number): Decision {
  return {
    id: `dec-uuid-${seq}`,
    docId: "doc-uuid-1",
    seq,
    title: `Decision ${seq}`,
    status: "resolved",
    resolution: "R".repeat(resolutionChars),
    context: "C".repeat(2_000),
    options: null,
    chosenOptionIndex: null,
    source: null,
    createdAt: baseDate,
    updatedAt: baseDate,
    resolvedAt: baseDate,
    previousStatus: null,
    actorUserId: null,
    actorName: null,
    channel: null,
  } as unknown as Decision;
}

function makeSpec(
  sections: DocSection[],
  opts: { sensitive?: boolean } = {},
): Doc & { sections: DocSection[] } {
  return {
    id: "doc-uuid-1",
    memexId: "test-account",
    handle: "spec-1",
    title: "Test Spec",
    docType: "spec",
    description: null,
    skillCapabilities: null,
    status: "build",
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
    sensitive: opts.sensitive ?? false,
    sensitiveByUserId: null,
    sensitiveByName: opts.sensitive ? "the person who flagged it" : null,
    checkedOutBy: null,
    checkedOutAt: null,
    checkedOutThread: null,
    version: 1,
    sections,
  } as unknown as Doc & { sections: DocSection[] };
}

function render(
  sections: DocSection[],
  decisions: Decision[] = [],
  opts: { sensitive?: boolean } = {},
): string {
  return formatFullDocState(makeSpec(sections, opts), decisions, []);
}

// A Spec that comfortably fits — the nine-in-ten case.
const SMALL_SECTIONS = [makeSection(1, "Some overview content.")];
// Prose alone larger than the whole measured cap: spec-472's real shape (85,580).
const HUGE_SECTIONS = [makeSection(1, "P".repeat(90_000))];

describe("tier 1 — a Spec that fits is not reshaped (ac-11)", () => {
  it("renders section bodies and decisions in full, background included", () => {
    tagAc(AC(11));
    const out = render(SMALL_SECTIONS, [makeDecision(1, 300)]);

    expect(out).toContain("Some overview content.");
    expect(out).toContain("R".repeat(300));
    // Background survives at tier 1 — only a budgeted render drops it.
    expect(out).toContain("Context: ");
    expect(out).not.toContain("shortened");
    expect(out.length).toBeLessThan(RESPONSE_BODY_BUDGET_CHARS);
  });

  it("says so rather than leaving completeness to be inferred", () => {
    tagAc(AC(13));
    expect(render(SMALL_SECTIONS)).toContain("Response shape: COMPLETE");
  });
});

describe("tier 2 — decisions are excerpted, and the excerpt is a door (ac-8)", () => {
  // Enough resolution weight to blow the budget on decisions alone, with prose
  // small enough that sections still fit.
  const many = Array.from({ length: 12 }, (_, i) => makeDecision(i + 1, 8_000));

  it("shortens the resolution and says that it did", () => {
    tagAc(AC(8));
    const out = render(SMALL_SECTIONS, many);

    expect(out).toContain("Response shape: EXCERPTED");
    expect(out).toContain("shortened");
    // No decision's resolution survives whole…
    expect(out).not.toContain("R".repeat(8_000));
    // …and the whole response is inside the budget.
    expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
  });

  it("carries every decision's ref, so the shortened text has somewhere to lead", () => {
    tagAc(AC(8));
    const out = render(SMALL_SECTIONS, many);
    for (let seq = 1; seq <= 12; seq++) {
      expect(out).toContain(`ref: dec-${seq}`);
    }
  });

  it("keeps section bodies — tier 2 spends the decisions block, not the prose", () => {
    tagAc(AC(8));
    expect(render(SMALL_SECTIONS, many)).toContain("Some overview content.");
  });
});

describe("tier 3 — section bodies are withheld whole, never mid-sentence (ac-12, ac-14)", () => {
  it("replaces bodies with a map and lands inside the budget", () => {
    tagAc(AC(12));
    const out = render(HUGE_SECTIONS, [makeDecision(1, 300)]);

    expect(out).toContain("Response shape: SECTION MAP");
    expect(out).toContain("body not included");
    expect(out).toContain("## 1. Overview");
    expect(out).toMatch(/Section #1 \| ref: s-1/);
    expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
  });

  it("omits the body whole — no section stops partway through as if that were its content", () => {
    tagAc(AC(14));
    const out = render(HUGE_SECTIONS);
    // Not one character of the body is present. A prefix of any length would be
    // the mid-flow truncation dec-4 forbids.
    expect(out).not.toContain("PPPPPPPPPP");
  });
});

describe("signals survive every tier (ac-9, and the reason this Spec exists)", () => {
  it("carries the sensitivity warning in full on a Spec too large to render", () => {
    tagAc(AC(12));
    const out = render(HUGE_SECTIONS, [makeDecision(1, 300)], { sensitive: true });

    expect(out).toContain("SENSITIVE");
    expect(out).toContain("the person who flagged it");
    // …in the response itself, not in a payload the client would spill.
    expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
  });
});

describe("the tier line is never absent (ac-13)", () => {
  it("declares a shape on every tier, so absence is never the signal", () => {
    tagAc(AC(13));
    const cases = [
      render(SMALL_SECTIONS),
      render(SMALL_SECTIONS, Array.from({ length: 12 }, (_, i) => makeDecision(i + 1, 8_000))),
      render(HUGE_SECTIONS),
    ];
    for (const out of cases) {
      expect(out).toMatch(/^Response shape: (COMPLETE|EXCERPTED|SECTION MAP)/m);
    }
    // And the three cases really are three different shapes.
    const shapes = new Set(
      cases.map((o) => o.match(/^Response shape: ([A-Z ]+)/m)?.[1]?.trim()),
    );
    expect(shapes.size).toBe(3);
  });
});
