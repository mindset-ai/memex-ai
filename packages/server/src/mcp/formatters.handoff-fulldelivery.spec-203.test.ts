// spec-203 Layer 2 (dec-2): the footer renderer is dumb — when the centralized
// machine hands it a pre-resolved FULL handoff via `nudge.fullHandoff`, it emits
// that in place of the Layer 1 compressed essence; otherwise it emits the
// essence. This proves the either/or at the renderer boundary (formatSpecGuidance
// is exported; the decision logic itself is covered by handoff-delivery.test.ts,
// and the end-to-end wiring by the integration test).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
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
        actorUserId: null,
        actorName: null,
        channel: null,
      },
    ],
  };
}

const ESSENCE_MARKER = 'You are now in build.';
const FULL_SENTINEL = "FULL-HANDOFF-SENTINEL-You-are-working-in-Memex";

describe("formatSpecGuidance — full-handoff vs essence in the footer (spec-203 L2)", () => {
  it("emits the provided full handoff in place of the essence", () => {
    tagAc(AC(9));
    const out = formatSpecGuidance(
      makeSpec("build"),
      [],
      [], { fullHandoff: FULL_SENTINEL },
    );
    expect(out).toContain(FULL_SENTINEL);
    expect(out).not.toContain(ESSENCE_MARKER); // essence suppressed when full is delivered
  });

  it("falls back to the compressed essence when no full handoff is provided", () => {
    tagAc(AC(9));
    const out = formatSpecGuidance(makeSpec("build"), [], []);
    expect(out).toContain(ESSENCE_MARKER);
    expect(out).not.toContain(FULL_SENTINEL);
  });
});
