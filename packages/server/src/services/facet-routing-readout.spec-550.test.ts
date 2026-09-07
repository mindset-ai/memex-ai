// spec-550 t-1 (dec-1) — the readout declares, PER CALL, which ranker actually scored it.
//
// Pure: `formatRoutedStandards` is a renderer over a `RoutingResult`, so these drive it
// with hand-built results and need no DB. The degrade path itself (a re-ranker that
// throws -> rankerModel falls back to KEYLESS_MODEL) is exercised against the real
// `routeFacets` in facet-routing.integration.test.ts; here we assert what the caller is
// TOLD for each of the two ranker states.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatRoutedStandards, KEYLESS_MODEL, type RoutingResult } from "./facet-routing.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-550";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const RERANKER = "cohere:rerank-v3.5";

// One surfaced standard is enough — the declaration rides the heading, not the entries.
function resultWith(rankerModel: string): RoutingResult {
  const std = {
    handle: "std-50",
    title: "A value one component depends on and another owns is declared, never defaulted",
    facetKeys: ["api-design"],
    score: 1,
    surfaced: true,
    sections: [],
  };
  return { surfaced: [std], all: [std], k: 10, rankerModel };
}

// A realistic shape: a wide candidate field, only the top K surfaced. Scores descend
// from the normalised 1.00 leader, exactly as routeFacets produces them.
function wideResult(surfacedCount = 3, totalCount = 24): RoutingResult {
  const mk = (i: number, surfaced: boolean) => ({
    handle: `std-${i + 1}`,
    title: `Standard number ${i + 1}`,
    facetKeys: ["api-design"],
    score: 1 - i / totalCount,
    surfaced,
    sections: [],
  });
  const all = Array.from({ length: totalCount }, (_, i) => mk(i, i < surfacedCount));
  return { surfaced: all.slice(0, surfacedCount), all, k: 10, rankerModel: RERANKER };
}

describe("spec-550 dec-1 — the readout names the ranker that actually scored this call", () => {
  it("names the ranker's model id (ac-4)", () => {
    tagAc(AC(4));
    expect(formatRoutedStandards(resultWith(RERANKER))).toContain(RERANKER);
    expect(formatRoutedStandards(resultWith(KEYLESS_MODEL))).toContain(KEYLESS_MODEL);
  });

  it("states the ballot did NOT order the list when a re-ranker scored it (ac-5, ac-1)", () => {
    tagAc(AC(5));
    tagAc(AC(1));
    const readout = formatRoutedStandards(resultWith(RERANKER));
    // The caller must be able to learn the ballot's ranking contribution was dropped —
    // naming the model alone (option A, rejected) would not carry this.
    expect(readout).toMatch(/did not order/i);
    expect(readout).toMatch(/ballot/i);
  });

  it("states the ballot DID order the list when the keyless baseline scored it (ac-5, ac-1)", () => {
    tagAc(AC(5));
    tagAc(AC(1));
    const readout = formatRoutedStandards(resultWith(KEYLESS_MODEL));
    expect(readout).toMatch(/ordered them/i);
    expect(readout).not.toMatch(/did not order/i);
  });

  it("is computed per call, not per deployment (ac-1)", () => {
    tagAc(AC(1));
    // The whole point of dec-1: the ranker can differ between two consecutive calls in
    // one process (the silent `catch` degrade — measured at 1 of 23 in a single prod
    // session). Two renders back-to-back in THIS process must disagree, which no
    // env-read or module-level constant could produce.
    const reranked = formatRoutedStandards(resultWith(RERANKER));
    const keyless = formatRoutedStandards(resultWith(KEYLESS_MODEL));
    expect(reranked).not.toEqual(keyless);
    expect(reranked).toContain(RERANKER);
    expect(keyless).toContain(KEYLESS_MODEL);
    expect(keyless).not.toContain(RERANKER);
  });

  it("says nothing when nothing is surfaced (ac-4)", () => {
    tagAc(AC(4));
    // An empty routing emits no readout at all; the declaration must not resurrect one.
    expect(formatRoutedStandards({ surfaced: [], all: [], k: 10, rankerModel: RERANKER })).toBe("");
  });
});

describe("spec-550 dec-2 — a rank the caller can act on, not a score that is 1.00 by construction", () => {
  it("prints no `relevance` token and no normalised score (ac-6, ac-2)", () => {
    tagAc(AC(6));
    tagAc(AC(2));
    const readout = formatRoutedStandards(wideResult());
    expect(readout).not.toMatch(/relevance/i);
    // No bare 0..1 decimal anywhere an entry header could carry one.
    expect(readout).not.toMatch(/\b[01]\.\d{2}\b/);
  });

  it("carries each standard's rank and the FULL candidate count, not k (ac-6, ac-2)", () => {
    tagAc(AC(6));
    tagAc(AC(2));
    // 3 surfaced, k=10, 24 candidates — so k, surfaced.length and all.length all differ
    // and only the right one can satisfy this.
    const readout = formatRoutedStandards(wideResult(3, 24));
    expect(readout).toMatch(/rank 1 of 24/);
    expect(readout).toMatch(/rank 2 of 24/);
    expect(readout).toMatch(/rank 3 of 24/);
    expect(readout).not.toMatch(/of 10\b/); // not k
    expect(readout).not.toMatch(/of 3\b/); // not surfaced.length
  });

  it("leaves the surfaced order and membership exactly as given (ac-7, ac-3)", () => {
    tagAc(AC(7));
    tagAc(AC(3));
    const r = wideResult(3, 24);
    const readout = formatRoutedStandards(r);
    const rendered = [...readout.matchAll(/▸ (std-\d+)/g)].map((m) => m[1]);
    expect(rendered).toEqual(r.surfaced.map((s) => s.handle));
  });

  it("keeps the score on the result object — only the READOUT drops it (ac-7)", () => {
    tagAc(AC(7));
    // dec-2 changes a rendered token, not the data model: `logRouting` still persists
    // every candidate's score, and re-tuning K offline still depends on it.
    const r = wideResult();
    formatRoutedStandards(r);
    expect(r.all.every((s) => typeof s.score === "number")).toBe(true);
    expect(r.all[0].score).toBe(1);
  });
});
