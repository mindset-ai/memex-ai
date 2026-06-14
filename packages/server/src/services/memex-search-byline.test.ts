import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  formatSearchResults,
  type MemexSearchHit,
} from "./memex-search.js";

// spec-259 t-4 — PURE unit tests of the search-result formatter. No DB: we hand
// `formatSearchResults` synthetic MemexSearchHit objects plus a fixed `now`, so
// timeAgo() output is deterministic. Covers:
//   ac-9  — per-section WHO/WHEN on multi-section doc hits; capitalizeDisplayName
//           applied to authors; rendered timestamp moved to relative timeAgo()
//           (dec-5), while the structured object keeps absolute ISO.
//   ac-12 — the lightweight open-comment indicator line (count + oldest age,
//           no comment content); rendered only when open comments exist.

// Fixed clock: 2026-06-14T12:00:00Z. timeAgo() ages everything against this.
const NOW = new Date("2026-06-14T12:00:00.000Z");

// ISO helpers anchored to NOW so the relative ages are stable.
const THREE_DAYS_AGO = "2026-06-11T12:00:00.000Z"; // "3d ago"
const FIVE_DAYS_AGO = "2026-06-09T12:00:00.000Z"; // "5d ago"
const SIX_DAYS_AGO = "2026-06-08T12:00:00.000Z"; // "6d ago" (still < 1 week)

function docHit(overrides: Partial<MemexSearchHit> = {}): MemexSearchHit {
  return {
    id: "doc-uuid-1",
    kind: "document",
    path: "ns/mx/docs/doc-1",
    title: "Some Doc",
    status: "active",
    score: 0.5,
    strategies: ["fts"],
    matchingSections: [],
    parentDocId: "doc-uuid-1",
    authorName: null,
    lastUpdatedAt: null,
    ...overrides,
  };
}

describe("formatSearchResults — per-section WHO/WHEN (spec-259 ac-9)", () => {
  it("renders each matched section's own author + relative age (section creators surface, not just the latest)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-259/acs/ac-9");
    const hit = docHit({
      authorName: "ada lovelace",
      lastUpdatedAt: THREE_DAYS_AGO,
      matchingSections: [
        {
          id: "s1",
          sectionType: "prose",
          title: "Intro",
          content: "intro body",
          matchedVia: "fts",
          authorName: "grace hopper",
          lastUpdatedAt: FIVE_DAYS_AGO,
        },
        {
          id: "s2",
          sectionType: "prose",
          title: "Details",
          content: "details body",
          matchedVia: "vector",
          authorName: "alan turing",
          lastUpdatedAt: SIX_DAYS_AGO,
        },
      ],
    });

    const out = formatSearchResults("q", [hit], { now: NOW });

    // Each section line carries ITS OWN author + age, not the doc-level latest.
    expect(out).toContain(`- Section "Intro" (fts) · Grace Hopper, 5d ago:`);
    expect(out).toContain(`- Section "Details" (vector) · Alan Turing, 6d ago:`);
  });

  it("applies capitalizeDisplayName to the heading author and uses relative timeAgo (dec-5)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-259/acs/ac-9");
    const hit = docHit({ authorName: "ada lovelace", lastUpdatedAt: THREE_DAYS_AGO });

    const out = formatSearchResults("q", [hit], { now: NOW });

    // Capitalized author + relative age in the heading byline.
    expect(out).toContain("· Ada Lovelace, 3d ago");
    // No absolute YYYY-MM-DD in the rendered output (dec-5 moved it to relative).
    expect(out).not.toContain("2026-06-11");
  });

  it("keeps the structured object's authorName/lastUpdatedAt as absolute ISO (wire fields unchanged)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-259/acs/ac-9");
    const hit = docHit({
      authorName: "ada lovelace",
      lastUpdatedAt: THREE_DAYS_AGO,
      matchingSections: [
        {
          id: "s1",
          sectionType: "prose",
          title: "Intro",
          content: "body",
          matchedVia: "fts",
          authorName: "grace hopper",
          lastUpdatedAt: FIVE_DAYS_AGO,
        },
      ],
    });

    // Formatting does not mutate the structured object — ISO + raw casing survive.
    formatSearchResults("q", [hit], { now: NOW });
    expect(hit.lastUpdatedAt).toBe(THREE_DAYS_AGO);
    expect(hit.authorName).toBe("ada lovelace");
    expect(hit.matchingSections[0].lastUpdatedAt).toBe(FIVE_DAYS_AGO);
    expect(hit.matchingSections[0].authorName).toBe("grace hopper");
  });

  it("degrades gracefully when a section has no author or timestamp", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-259/acs/ac-9");
    const hit = docHit({
      matchingSections: [
        {
          id: "s1",
          sectionType: "prose",
          title: "Intro",
          content: "body",
          matchedVia: "fts",
          authorName: null,
          lastUpdatedAt: null,
        },
      ],
    });

    const out = formatSearchResults("q", [hit], { now: NOW });
    // No byline appended — line ends right after the (via) segment.
    expect(out).toContain(`- Section "Intro" (fts):`);
  });
});

describe("formatSearchResults — open-comment indicator (spec-259 ac-12)", () => {
  it("renders one indicator line with count + oldest age, no comment content", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-259/acs/ac-12");
    const hit = docHit({
      openComments: { count: 2, oldestCreatedAt: THREE_DAYS_AGO },
    });

    const out = formatSearchResults("q", [hit], { now: NOW });
    expect(out).toContain("- (2 open comments, oldest 3d ago)");
  });

  it("singularises the noun for a single open comment", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-259/acs/ac-12");
    const hit = docHit({
      openComments: { count: 1, oldestCreatedAt: FIVE_DAYS_AGO },
    });

    const out = formatSearchResults("q", [hit], { now: NOW });
    expect(out).toContain("- (1 open comment, oldest 5d ago)");
  });

  it("renders NO indicator line when the hit has zero open comments", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-259/acs/ac-12");
    const hit = docHit({ openComments: undefined });

    const out = formatSearchResults("q", [hit], { now: NOW });
    expect(out).not.toContain("open comment");
  });

  it("attaches the indicator to a decision hit (doc-scoped) without its content", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-259/acs/ac-12");
    const hit = docHit({
      kind: "decision",
      path: "ns/mx/specs/spec-1/decisions/dec-1",
      decisionSnippet: "the decision body",
      decisionMatchedVia: "fts",
      openComments: { count: 3, oldestCreatedAt: SIX_DAYS_AGO },
    });

    const out = formatSearchResults("q", [hit], { now: NOW });
    expect(out).toContain("- (3 open comments, oldest 6d ago)");
  });
});
