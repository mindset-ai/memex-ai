// spec-423 ac-18 — hybrid candidate generation: the candidate set is the UNION of the
// facet-overlap arm and a semantic arm (searchMemex), RRF-fused with normalized scores.
// The semantic arm is MOCKED here so the union / collision / degradation behaviour is
// deterministic without embeddings or network (the facet arm still hits the real DB).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";

// Controllable semantic arm. Default: no hits (the degraded / keyless case).
const searchMemexMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
vi.mock("./memex-search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./memex-search.js")>()),
  searchMemex: (...args: unknown[]) => searchMemexMock(...args),
}));

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
import { routeFacets } from "./facet-routing.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-423";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let orgId: string;
const facetId = new Map<string, string>();

// A synthetic semantic hit shaped like a MemexSearchHit; `path`'s last segment is the handle.
function semanticHit(handle: string, score: number) {
  return { path: `mindset-prod/x/standards/${handle}`, title: handle, id: `doc-${handle}`, score, matchingSections: [] };
}

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

async function seedStandard(handle: string, title: string, clauseTags: string[][]): Promise<void> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title, docType: "standard", status: "approved" })
    .returning();
  const [section] = await db
    .insert(docSections)
    .values({ docId: doc.id, sectionType: "rule", content: title, seq: 1, position: 1 })
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
  memexId = await makeTestMemex("fahyb");
  orgId = await orgIdFor(memexId);
  for (const key of ["hy-security", "hy-perf"]) {
    const [f] = await db.insert(facets).values({ ownerType: "org", ownerId: orgId, key, description: key }).returning();
    facetId.set(key, f.id);
  }
  // One facet-governed standard: the facet arm will always return this for hy-security.
  await seedStandard("std-hy-facet", "Facet-governed", [["hy-security"]]);
});

afterAll(async () => {
  await db.delete(documents).where(and(eq(documents.memexId, memexId), eq(documents.handle, "std-hy-facet"))).catch(() => {});
  await db.delete(facets).where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId))).catch(() => {});
  vi.restoreAllMocks();
});

beforeEach(() => {
  searchMemexMock.mockReset();
  searchMemexMock.mockResolvedValue([]);
});

describe("hybrid candidate generation — facet ∪ semantic (spec-423, ac-18)", () => {
  it("UNIONS a semantic-only standard (no facet overlap) into the candidate set, tagged with empty facetKeys (ac-18)", async () => {
    tagAc(AC(18));
    // Semantic arm surfaces a standard the facet arm can't (its clauses were never tagged).
    searchMemexMock.mockResolvedValue([semanticHit("std-hy-semantic", 0.9)]);
    const r = await routeFacets(memexId, ["hy-security"], "some work text", null);
    const handles = r.all.map((s) => s.handle);
    expect(handles).toContain("std-hy-facet"); // facet arm
    expect(handles).toContain("std-hy-semantic"); // semantic arm — would be missed without the union
    // Provenance: a semantic-only candidate carries no facet keys.
    const sem = r.all.find((s) => s.handle === "std-hy-semantic")!;
    expect(sem.facetKeys).toEqual([]);
    // Scores are normalized to 0..1 with the top at 1.0.
    expect(Math.max(...r.all.map((s) => s.score))).toBeCloseTo(1.0);
    expect(r.all.every((s) => s.score >= 0 && s.score <= 1)).toBe(true);
  });

  it("on a handle COLLISION the facet candidate wins the merge (keeps its facet keys) (ac-18)", async () => {
    tagAc(AC(18));
    // The semantic arm returns the SAME standard the facet arm found.
    searchMemexMock.mockResolvedValue([semanticHit("std-hy-facet", 0.99)]);
    const r = await routeFacets(memexId, ["hy-security"], "some work text", null);
    const facetRows = r.all.filter((s) => s.handle === "std-hy-facet");
    expect(facetRows).toHaveLength(1); // merged, not duplicated
    expect(facetRows[0].facetKeys).toContain("hy-security"); // facet metadata survived the merge
  });

  it("degrades to the facet arm alone when the semantic arm is empty — never blocks (ac-18)", async () => {
    tagAc(AC(18));
    searchMemexMock.mockResolvedValue([]); // no embedding provider / no hits
    const r = await routeFacets(memexId, ["hy-security"], "some work text", null);
    expect(r.all.map((s) => s.handle)).toEqual(["std-hy-facet"]);
  });

  it("degrades to the facet arm on a semantic-arm ERROR — never throws (ac-18)", async () => {
    tagAc(AC(18));
    searchMemexMock.mockRejectedValue(new Error("retriever outage"));
    const r = await routeFacets(memexId, ["hy-security"], "some work text", null);
    expect(r.all.map((s) => s.handle)).toEqual(["std-hy-facet"]);
  });
});
