// spec-203 dec-3 (t-3) ac-13: formatFullDocState is the single composer of the
// response envelope. Tools inject guidance as InjectedBlock[] tagged with a zone;
// the composer places header blocks before the doc and footer blocks after the
// machine footer, by zone alone — no tool-name logic.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatFullDocState, type InjectedBlock } from "./formatters.js";
import { FOOTER_DELIMITER } from "./footer-delimiter.js";
import type { Doc, DocSection } from "../db/schema.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-203/acs/ac-${n}`;

const baseDate = new Date("2026-03-25T12:00:00Z");

function makeSpec(): Doc & { sections: DocSection[] } {
  return {
    id: "doc-uuid-1",
    memexId: "test-account",
    handle: "spec-1",
    title: "Test Spec",
    docType: "spec",
    status: "build",
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

// Helper: call with a trailing blocks arg (positional #10).
function render(blocks?: InjectedBlock[]): string {
  return formatFullDocState(
    makeSpec(),
    [],
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    blocks,
  );
}

describe("formatFullDocState — injected-block envelope (spec-203 dec-3)", () => {
  it("places a header block before the doc title", () => {
    tagAc(AC(13));
    const out = render([{ zone: "header", content: "HEADER-BLOCK-X\n\n" }]);
    expect(out.indexOf("HEADER-BLOCK-X")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("HEADER-BLOCK-X")).toBeLessThan(out.indexOf("# Test Spec"));
  });

  it("places a footer block after the machine footer (below the delimiter)", () => {
    tagAc(AC(13));
    const out = render([{ zone: "footer", content: "FOOTER-BLOCK-Y" }]);
    expect(out.indexOf("FOOTER-BLOCK-Y")).toBeGreaterThan(out.indexOf(FOOTER_DELIMITER));
    // …and after the handoff that the machine footer carries.
    expect(out.indexOf("FOOTER-BLOCK-Y")).toBeGreaterThan(
      out.indexOf("BUILD handoff (full prompt:"),
    );
  });

  it("renders multiple footer blocks in array order", () => {
    tagAc(AC(13));
    const out = render([
      { zone: "footer", content: "FIRST" },
      { zone: "footer", content: "SECOND" },
    ]);
    expect(out.indexOf("FIRST")).toBeLessThan(out.indexOf("SECOND"));
  });

  it("composes header and footer together, by zone alone (no tool-name logic)", () => {
    tagAc(AC(13));
    const out = render([
      { zone: "footer", content: "THE-FOOTER" },
      { zone: "header", content: "THE-HEADER\n\n" },
    ]);
    // Declared order is footer-then-header, but ZONE decides placement:
    expect(out.indexOf("THE-HEADER")).toBeLessThan(out.indexOf("# Test Spec"));
    expect(out.indexOf("THE-FOOTER")).toBeGreaterThan(out.indexOf(FOOTER_DELIMITER));
  });

  it("with no blocks, output is byte-identical to omitting the arg", () => {
    tagAc(AC(13));
    expect(render([])).toBe(render(undefined));
  });
});
