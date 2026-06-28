// spec-423 t-8 (dec-7) — the doc-view projection: each task/decision carries its cast
// facet keys so the UI renders them as pills. Tasks/decisions with no ballot project [].

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, tasks, decisions, facets, namespaces, memexes } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { castTaskBallot, castDecisionBallot, facetKeysByTask, facetKeysByDecision } from "./facet-ballot.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-423";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let orgId: string;
let specDocId: string;
let balloted: string;
let unballoted: string;
let decId: string;

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
  memexId = await makeTestMemex("facproj");
  orgId = await orgIdFor(memexId);
  await db.insert(facets).values([
    { ownerType: "org", ownerId: orgId, key: "xf-security", description: "x" },
    { ownerType: "org", ownerId: orgId, key: "xf-perf", description: "x" },
  ]);
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-facproj", title: "Proj", docType: "spec", status: "build" })
    .returning();
  specDocId = doc.id;
  const [t1] = await db.insert(tasks).values({ memexId, docId: specDocId, seq: 1, title: "balloted", description: "d" }).returning();
  balloted = t1.id;
  const [t2] = await db.insert(tasks).values({ memexId, docId: specDocId, seq: 2, title: "unballoted", description: "d" }).returning();
  unballoted = t2.id;
  const [d1] = await db.insert(decisions).values({ memexId, docId: specDocId, seq: 1, title: "dec" }).returning();
  decId = d1.id;

  await castTaskBallot(memexId, specDocId, balloted, { verdict: { "xf-security": true, "xf-perf": false }, none: false }, {});
  await castDecisionBallot(memexId, specDocId, decId, { verdict: { "xf-security": false, "xf-perf": true }, none: false }, {});
});

afterAll(async () => {
  if (specDocId) await db.delete(documents).where(eq(documents.id, specDocId)).catch(() => {});
  await db.delete(facets).where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId))).catch(() => {});
});

describe("doc-view facet projection (spec-423 t-8, dec-7)", () => {
  it("projects each task's true facet keys; an unballoted task projects nothing (ac-15)", async () => {
    tagAc(AC(15));
    const map = await facetKeysByTask(memexId, [balloted, unballoted]);
    expect(map.get(balloted)).toEqual(["xf-security"]);
    expect(map.get(unballoted)).toBeUndefined(); // caller defaults to []
  });

  it("projects each decision's true facet keys (ac-15)", async () => {
    tagAc(AC(15));
    const map = await facetKeysByDecision(memexId, [decId]);
    expect(map.get(decId)).toEqual(["xf-perf"]);
  });
});
