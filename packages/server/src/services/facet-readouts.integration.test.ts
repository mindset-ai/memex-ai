// spec-340 t-6 — coverage threshold + the two readouts. All plain queries over
// the stored ballots + tags.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  docSections,
  standardClauses,
  tasks,
  namespaces,
  memexes,
} from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { seedDefaultFacets } from "./default-facets.js";
import { vocabForMemex, tagClause, type VocabFacet } from "./facet-classifier.js";
import { castTaskBallot } from "./facet-ballot.js";
import { specFacetUnion } from "./facet-routing.js";
import { coverageThreshold, facetDemand, coverageGaps, standardPopularity } from "./facet-readouts.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let vocab: VocabFacet[];
let specDocId: string;
const allFalse = (v: VocabFacet[]) => Object.fromEntries(v.map((f) => [f.key, false]));

async function taskWithBallot(seq: number, trueKeys: string[]): Promise<void> {
  const [t] = await db.insert(tasks).values({ memexId, docId: specDocId, seq, title: `t${seq}`, description: "d" }).returning();
  const verdict = { ...allFalse(vocab) };
  for (const k of trueKeys) verdict[k] = true;
  await castTaskBallot(memexId, t.id, { verdict, none: false });
}

beforeAll(async () => {
  memexId = await makeTestMemex("frdo");
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  await seedDefaultFacets(row!.orgId!);
  vocab = await vocabForMemex(memexId);

  // A standard governing `security` (so security is covered, not a gap).
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "std-sec6", title: "Security std", docType: "standard", status: "approved" })
    .returning();
  const [section] = await db
    .insert(docSections)
    .values({ docId: doc.id, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  const [clause] = await db
    .insert(standardClauses)
    .values({ memexId, docId: doc.id, sectionId: section.id, seq: 1, position: 1, body: "sec rule" })
    .returning();
  await tagClause(memexId, clause.id, ["security"], vocab);

  // Demand: security ×2 (covered), accessibility ×2 (NO standard → gap),
  // performance ×1 (below threshold → not a gap).
  const [spec] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-rdo", title: "readout spec", docType: "spec", status: "build" })
    .returning();
  specDocId = spec.id;
  await taskWithBallot(1, ["security", "accessibility"]);
  await taskWithBallot(2, ["security", "accessibility"]);
  await taskWithBallot(3, ["performance"]);
});

afterEach(() => {
  delete process.env.MEMEX_FACET_COVERAGE_THRESHOLD;
});

describe("coverage threshold (spec-340 t-6)", () => {
  it("defaults to 2 and is read from config, not baked (ac-15)", () => {
    tagAc(AC(15));
    expect(coverageThreshold()).toBe(2);
    process.env.MEMEX_FACET_COVERAGE_THRESHOLD = "3";
    expect(coverageThreshold()).toBe(3);
    process.env.MEMEX_FACET_COVERAGE_THRESHOLD = "garbage";
    expect(coverageThreshold()).toBe(2); // invalid → default
  });
});

describe("coverage gaps (spec-340 t-6)", () => {
  it("flags facets touched >= threshold with no governing standard, ranked by demand (ac-6)", async () => {
    tagAc(AC(6));
    const gaps = await coverageGaps(memexId);
    // accessibility: demand 2, no standard → gap. security: covered. performance: below threshold.
    expect(gaps.map((g) => g.facetKey)).toEqual(["accessibility"]);
    expect(gaps[0].demand).toBe(2);
  });

  it("the threshold post-filters the SAME ballots the routing union reads (ac-16)", async () => {
    tagAc(AC(16));
    const demand = await facetDemand(memexId);
    expect(demand.get("performance")).toBe(1);

    // The union (recall-first) INCLUDES performance — any task counts.
    const union = await specFacetUnion(memexId, specDocId);
    expect(union).toContain("performance");

    // The coverage map (discriminating) EXCLUDES it at threshold 2 — same data,
    // two aggregators.
    const gaps = await coverageGaps(memexId, 2);
    expect(gaps.map((g) => g.facetKey)).not.toContain("performance");

    // Lower the threshold to 1 and performance becomes a gap (no standard governs it).
    const gapsAt1 = await coverageGaps(memexId, 1);
    expect(gapsAt1.map((g) => g.facetKey)).toContain("performance");
  });
});

describe("standard popularity (spec-340 t-6)", () => {
  it("sums the demand of the facets each surfaced standard governs (ac-6)", async () => {
    tagAc(AC(6));
    const pop = await standardPopularity(memexId);
    const sec = pop.find((p) => p.handle === "std-sec6");
    expect(sec).toBeDefined();
    expect(sec!.demand).toBe(2); // two tasks marked security true
  });
});
