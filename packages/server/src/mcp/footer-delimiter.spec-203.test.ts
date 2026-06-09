// spec-203 dec-3 (t-4) ac-11: the footer delimiter is the single source of truth
// that makes the platform footer machine-separable from the tool's real output.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { FOOTER_DELIMITER, splitToolResult } from "./footer-delimiter.js";
import { formatSpecGuidance } from "./formatters.js";
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

describe("splitToolResult", () => {
  it("splits a result into body + footer at the delimiter", () => {
    tagAc(AC(11));
    const result = `the real tool output\n${FOOTER_DELIMITER}\nthe platform footer`;
    const { body, footer } = splitToolResult(result);
    expect(body).toBe("the real tool output\n");
    expect(footer).toBe("the platform footer");
  });

  it("returns footer=null when no delimiter is present (no footer injected)", () => {
    tagAc(AC(11));
    const { body, footer } = splitToolResult("just tool output, no footer");
    expect(body).toBe("just tool output, no footer");
    expect(footer).toBeNull();
  });

  it("splits on the FIRST delimiter occurrence", () => {
    tagAc(AC(11));
    const { footer } = splitToolResult(`a ${FOOTER_DELIMITER} b ${FOOTER_DELIMITER} c`);
    expect(footer).toContain("b ");
    expect(footer).toContain("c");
  });
});

describe("formatSpecGuidance — footer delimiter boundary (spec-203 dec-3)", () => {
  it("emits the delimiter exactly once at the doc-state→footer boundary for a Spec", () => {
    tagAc(AC(11));
    const out = formatSpecGuidance(makeSpec("build"), [], []);
    const occurrences = out.split(FOOTER_DELIMITER).length - 1;
    expect(occurrences).toBe(1);
    // spec-203 ac-15: the composer's output IS the footer — it leads with the
    // delimiter, and splitting recovers the phase guidance. (Body↔footer
    // separation on a REAL tool result is the choke point's job, covered by
    // services/spec-footer-on-terse.integration.test.ts.)
    expect(out.startsWith(FOOTER_DELIMITER)).toBe(true);
    const { footer } = splitToolResult(out);
    expect(footer).toContain("BUILD handoff (full prompt:");
  });

  it("emits NO delimiter for a non-Spec doc (no footer to separate)", () => {
    tagAc(AC(11));
    const doc = { ...makeSpec("build"), docType: "document" };
    const out = formatSpecGuidance(doc, [], []);
    expect(out).not.toContain(FOOTER_DELIMITER);
    expect(splitToolResult(out).footer).toBeNull();
  });
});
