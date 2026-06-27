// spec-423 t-3 — recall-first routing (dec-1) + ranking/surfacing (dec-2/dec-3).
// DB-backed: seeds standards with facet-tagged clauses and exercises the real join +
// density + the injectable re-ranker (mocked — no network).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  docSections,
  standardClauses,
  standardClauseFacets,
  facets,
  namespaces,
  memexes,
} from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { routeFacets, formatRoutedStandards, KEYLESS_MODEL } from "./facet-routing.js";
import type { Reranker } from "./facet-rerank.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-423";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let orgId: string;
const facetId = new Map<string, string>();

async function orgIdFor(mid: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, mid))
    .limit(1);
  if (!row?.orgId) throw new Error("no org");
  return row.orgId;
}

// Seed a standard whose clauses are tagged per `clauseTags` (one entry per clause,
// each a list of facet keys that clause governs).
async function seedStandard(handle: string, title: string, clauseTags: string[][]): Promise<void> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title, docType: "standard", status: "approved" })
    .returning();
  const [section] = await db
    .insert(docSections)
    .values({ docId: doc.id, sectionType: "rule", content: `${title} — ${clauseTags.flat().join(" ")}`, seq: 1, position: 1 })
    .returning();
  for (let i = 0; i < clauseTags.length; i++) {
    const [cl] = await db
      .insert(standardClauses)
      .values({ memexId, docId: doc.id, sectionId: section.id, seq: i + 1, position: i + 1, body: `clause ${i}` })
      .returning();
    for (const key of clauseTags[i]) {
      await db.insert(standardClauseFacets).values({ memexId, clauseId: cl.id, facetId: facetId.get(key)! });
    }
  }
}

beforeAll(async () => {
  memexId = await makeTestMemex("facrt");
  orgId = await orgIdFor(memexId);
  for (const key of ["zb-security", "zb-perf", "zb-other"]) {
    const [f] = await db.insert(facets).values({ ownerType: "org", ownerId: orgId, key, description: key }).returning();
    facetId.set(key, f.id);
  }
  // FOCUSED: both clauses about security → density 1.0
  await seedStandard("std-zb-focused", "Focused security", [["zb-security"], ["zb-security"]]);
  // CATCH-ALL: 1 of 4 tagged clauses about security → density 0.25
  await seedStandard("std-zb-catchall", "Catch-all", [["zb-security"], ["zb-other"], ["zb-other"], ["zb-perf"]]);
  // THIRD security-governing standard (recall-first must include it).
  await seedStandard("std-zb-third", "Third", [["zb-security"], ["zb-other"]]);
  // A standard that does NOT govern security at all — must NEVER be a candidate.
  await seedStandard("std-zb-unrelated", "Unrelated", [["zb-perf"], ["zb-other"]]);
});

afterAll(async () => {
  for (const h of ["std-zb-focused", "std-zb-catchall", "std-zb-third", "std-zb-unrelated"]) {
    await db.delete(documents).where(and(eq(documents.memexId, memexId), eq(documents.handle, h))).catch(() => {});
  }
  await db.delete(facets).where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId))).catch(() => {});
});

describe("recall-first routing (spec-423 t-3, dec-1)", () => {
  it("returns EVERY standard governing a balloted facet, and only those (ac-9, ac-3)", async () => {
    tagAc(AC(9));
    tagAc(AC(3)); // scope: recall-first — no governing standard dropped by a relevance threshold
    const r = await routeFacets(memexId, ["zb-security"], "work about auth", null);
    const handles = new Set(r.all.map((s) => s.handle));
    expect(handles).toEqual(new Set(["std-zb-focused", "std-zb-catchall", "std-zb-third"]));
    expect(handles.has("std-zb-unrelated")).toBe(false);
  });

  it("keyless density ranks a focused standard above a catch-all (ac-9)", async () => {
    tagAc(AC(9));
    const r = await routeFacets(memexId, ["zb-security"], "auth", null);
    const focused = r.all.find((s) => s.handle === "std-zb-focused")!;
    const catchall = r.all.find((s) => s.handle === "std-zb-catchall")!;
    expect(focused.score).toBeGreaterThan(catchall.score);
    expect(focused.score).toBeCloseTo(1.0);
    expect(catchall.score).toBeCloseTo(0.25);
  });
});

describe("surfacing cut — top-K, no relevance floor, scores shown (spec-423 t-3, dec-2)", () => {
  it("caps at top-K (attention cut) with scores shown, nothing pruned from the full set (ac-10)", async () => {
    tagAc(AC(10));
    process.env.MEMEX_FACET_TOPK = "2";
    try {
      const r = await routeFacets(memexId, ["zb-security"], "auth", null);
      expect(r.k).toBe(2);
      expect(r.surfaced).toHaveLength(2); // 3 candidates, capped at 2 by attention
      expect(r.all).toHaveLength(3); // the full candidate set is never pruned (recall-first)
      // Ordered by score desc; every surfaced row carries its score.
      expect(r.surfaced[0].score).toBeGreaterThanOrEqual(r.surfaced[1].score);
      expect(r.surfaced.every((s) => typeof s.score === "number")).toBe(true);
      // The cut is purely positional: the lowest-score candidate falls outside K by
      // RANK, not by a relevance threshold.
      expect(r.surfaced.map((s) => s.handle)).toEqual(["std-zb-focused", "std-zb-third"]);
    } finally {
      delete process.env.MEMEX_FACET_TOPK;
    }
  });

  it("applies NO relevance floor — a low-score candidate still surfaces within K (ac-10, ac-3)", async () => {
    tagAc(AC(10));
    tagAc(AC(3)); // scope: only the top-K cap limits the list; a low-score standard is never floored
    // Default K (10) comfortably holds all 3 candidates. The catch-all scores only
    // 0.25 — a relevance floor would drop it; with no floor it is surfaced anyway.
    const r = await routeFacets(memexId, ["zb-security"], "auth", null);
    const catchall = r.surfaced.find((s) => s.handle === "std-zb-catchall");
    expect(catchall).toBeDefined();
    expect(catchall!.score).toBeCloseTo(0.25); // low score, surfaced regardless
  });

  it("formats the surfaced readout with visible scores (ac-10)", async () => {
    tagAc(AC(10));
    const r = await routeFacets(memexId, ["zb-security"], "auth", null);
    const readout = formatRoutedStandards(r);
    expect(readout).toContain("std-zb-focused");
    expect(readout).toMatch(/\(1\.00\)/); // score shown
  });
});

describe("ranking backend — keyless baseline + re-ranker degrade (spec-423 t-3, dec-3)", () => {
  it("uses the keyless density baseline when no credential is present (ac-11, ac-4)", async () => {
    tagAc(AC(11));
    tagAc(AC(4)); // scope: no key on self-host/free tier -> keyless density top-K
    const r = await routeFacets(memexId, ["zb-security"], "auth", null);
    expect(r.rankerModel).toBe(KEYLESS_MODEL);
  });

  it("uses the re-ranker's scores when present, overriding density order (ac-11)", async () => {
    tagAc(AC(11));
    // Mock reranker: rank the catch-all TOP (inverting the density order) to prove
    // the reranker score is what's used.
    const mock: Reranker = {
      model: "mock:rerank",
      rerank: async (_q, docs) =>
        new Map(docs.map((d) => [d.handle, d.handle === "std-zb-catchall" ? 0.99 : 0.01])),
    };
    const r = await routeFacets(memexId, ["zb-security"], "auth", mock);
    expect(r.rankerModel).toBe("mock:rerank");
    expect(r.all[0].handle).toBe("std-zb-catchall"); // reranker order won
  });

  it("degrades to the keyless baseline on re-ranker error — never throws (ac-11, ac-4)", async () => {
    tagAc(AC(11));
    tagAc(AC(4)); // scope: re-ranker unavailable -> keyless density top-K, work never blocked
    const boom: Reranker = {
      model: "mock:boom",
      rerank: async () => {
        throw new Error("provider outage");
      },
    };
    const r = await routeFacets(memexId, ["zb-security"], "auth", boom);
    expect(r.rankerModel).toBe(KEYLESS_MODEL); // degraded, non-blocking
    expect(r.all.length).toBe(3); // still recall-first
  });
});
