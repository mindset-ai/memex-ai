// spec-203 dec-1 (Layer 1): the in-chat footer machine emits the current
// phase's handoff essence on every spec-tool response.
//
// formatFullDocState is the one function ~22 spec-touching tools pass through
// to compose their footer (the Spec's "discovery"). These tests prove the
// compressed handoff essence now rides that footer for each forward phase —
// closing the spec-120 gap where a chat-driven build agent never saw the
// handoff's "minting tasks is your job / recommend verify" steps — and stays
// absent for draft/done.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatFullDocState } from "./formatters.js";
import { FOOTER_DELIMITER } from "./footer-delimiter.js";
import type { Doc, DocSection } from "../db/schema.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-203/acs/ac-${n}`;

const baseDate = new Date("2026-03-25T12:00:00Z");

function makeSpec(status: string): Doc & { sections: DocSection[] } {
  return {
    id: "doc-uuid-1",
    memexId: "test-account",
    handle: "spec-1",
    title: "Test Spec",
    docType: "spec",
    status,
    parentDocId: null,
    createdByUserId: null,
    createdAt: baseDate,
    statusChangedAt: baseDate,
    archivedAt: null,
    pausedAt: null,
    narrativeLastConsolidatedAt: null,
    isDemo: false,
    sections: [
      {
        id: "section-uuid-1",
        docId: "doc-uuid-1",
        sectionType: "overview",
        title: "Overview",
        description: null,
        content: "Some overview content.",
        seq: 1,
        preamble: null,
        position: 1,
        status: "active",
        previousStatus: null,
        createdAt: baseDate,
        updatedAt: baseDate,
      },
    ],
  };
}

describe("formatFullDocState — phase handoff essence in the footer (spec-203)", () => {
  it("emits the BUILD handoff essence on a build-phase Spec", () => {
    tagAc(AC(7));
    const out = formatFullDocState(makeSpec("build"), [], []);
    expect(out).toContain('BUILD handoff (full prompt: the "Build handoff" button)');
    expect(out).toContain("deriving the task graph");
    expect(out).toContain("recommend `verify`");
  });

  it("emits the SPECIFY handoff essence on a specify-phase Spec", () => {
    tagAc(AC(7));
    tagAc(AC(4)); // scope: phase-general (specify gets its handoff)
    const out = formatFullDocState(makeSpec("specify"), [], []);
    expect(out).toContain('SPECIFY handoff (full prompt: the "Plan handoff" button)');
  });

  it("emits the VERIFY handoff essence on a verify-phase Spec", () => {
    const out = formatFullDocState(makeSpec("verify"), [], []);
    expect(out).toContain('VERIFY handoff (full prompt: the "Verify handoff" button)');
  });

  it("emits NO handoff essence on a draft-phase Spec", () => {
    tagAc(AC(7));
    const out = formatFullDocState(makeSpec("draft"), [], []);
    expect(out).not.toContain("handoff (full prompt:");
  });

  it("emits NO handoff essence on a done-phase Spec", () => {
    tagAc(AC(7));
    tagAc(AC(4)); // scope: phase-general (done surfaces none)
    const out = formatFullDocState(makeSpec("done"), [], []);
    expect(out).not.toContain("handoff (full prompt:");
  });

  it("places the essence after the footer delimiter (in the footer, not the body)", () => {
    const out = formatFullDocState(makeSpec("build"), [], []);
    const delimIdx = out.indexOf(FOOTER_DELIMITER);
    const essenceIdx = out.indexOf("BUILD handoff (full prompt:");
    expect(delimIdx).toBeGreaterThanOrEqual(0);
    expect(essenceIdx).toBeGreaterThan(delimIdx);
  });
});
