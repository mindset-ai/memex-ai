// spec-423 t-7 (dec-9) — the gap-backfill: classify ONLY clauses with no facet tag
// yet (the Phase-1→Phase-2 window), leaving already-classified clauses untouched.
// Uses the deterministic `classify` seam (no LLM / no key).

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
import { backfillFacetTagsForMemex } from "./facet-classifier.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-423";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let orgId: string;
const facetId = new Map<string, string>();
const clauseIds: string[] = [];

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

beforeAll(async () => {
  memexId = await makeTestMemex("facgap");
  orgId = await orgIdFor(memexId);
  for (const key of ["xe-security", "xe-perf"]) {
    const [f] = await db.insert(facets).values({ ownerType: "org", ownerId: orgId, key, description: key }).returning();
    facetId.set(key, f.id);
  }
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "std-gap", title: "Gap standard", docType: "standard", status: "approved" })
    .returning();
  const [sec] = await db
    .insert(docSections)
    .values({ docId: doc.id, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  for (let i = 0; i < 3; i++) {
    const [cl] = await db
      .insert(standardClauses)
      .values({ memexId, docId: doc.id, sectionId: sec.id, seq: i + 1, position: i + 1, body: `clause ${i}` })
      .returning();
    clauseIds.push(cl.id);
  }
  // Pre-tag clause[0] (already classified, from before the hard-fail) — the gap
  // backfill must leave it alone.
  await db.insert(standardClauseFacets).values({ memexId, clauseId: clauseIds[0], facetId: facetId.get("xe-perf")! });
});

afterAll(async () => {
  await db.delete(documents).where(and(eq(documents.memexId, memexId), eq(documents.handle, "std-gap"))).catch(() => {});
  await db.delete(facets).where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId))).catch(() => {});
});

describe("gap-backfill classifies only untagged clauses (spec-423 t-7, dec-9)", () => {
  it("classifies ONLY clauses with no tag and leaves classified ones untouched (ac-16)", async () => {
    tagAc(AC(16));
    // Deterministic classifier: tag every clause it is asked to classify as xe-security.
    const res = await backfillFacetTagsForMemex(memexId, {
      gapOnly: true,
      classify: () => ["xe-security"],
    });
    // Only the 2 untagged clauses were processed (clause[0] skipped).
    expect(res.clauses).toBe(2);

    // clause[0] keeps its original xe-perf tag — untouched.
    const c0 = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, clauseIds[0]));
    expect(c0.map((r) => r.facetId)).toEqual([facetId.get("xe-perf")]);

    // clause[1] and clause[2] now carry the gap-backfilled xe-security tag.
    for (const id of [clauseIds[1], clauseIds[2]]) {
      const tags = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, id));
      expect(tags.map((r) => r.facetId)).toEqual([facetId.get("xe-security")]);
    }
  });

  it("no clause is left silently unclassified after the gap-backfill (ac-16)", async () => {
    tagAc(AC(16));
    for (const id of clauseIds) {
      const tags = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, id));
      expect(tags.length).toBeGreaterThanOrEqual(1); // every clause has a tag (member or none-marker)
    }
  });
});
