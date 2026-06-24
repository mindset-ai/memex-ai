// spec-340 t-7 — the facet gate at verify/done. Mirrors code-grounding: a
// structured facetAck param, surfaced as a prompt when absent and echoed when
// supplied, riding the readiness nudges. Non-blocking: update_doc still advances.

import { describe, it, expect, beforeAll } from "vitest";
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
import { assessPhaseTransition } from "./phase-assessment.js";
import { updateDocStatus } from "./documents.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let vocab: VocabFacet[];
const allFalse = (v: VocabFacet[]) => Object.fromEntries(v.map((f) => [f.key, false]));

async function specInVerifyWithSecurityWork(handle: string, withSecondUnballotedTask: boolean): Promise<string> {
  const [spec] = await db
    .insert(documents)
    .values({ memexId, handle, title: handle, docType: "spec", status: "verify" })
    .returning();
  const [t1] = await db.insert(tasks).values({ memexId, docId: spec.id, seq: 1, title: "a", description: "d", status: "complete" }).returning();
  await castTaskBallot(memexId, t1.id, { verdict: { ...allFalse(vocab), security: true }, none: false });
  if (withSecondUnballotedTask) {
    await db.insert(tasks).values({ memexId, docId: spec.id, seq: 2, title: "b", description: "d", status: "complete" });
  }
  return spec.id;
}

beforeAll(async () => {
  memexId = await makeTestMemex("fgat");
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  await seedDefaultFacets(row!.orgId!);
  vocab = await vocabForMemex(memexId);

  // A standard governing `security`, so the spec's security work routes to it.
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "std-sec7", title: "Security std", docType: "standard", status: "approved" })
    .returning();
  const [section] = await db
    .insert(docSections)
    .values({ docId: doc.id, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  const [clause] = await db
    .insert(standardClauses)
    .values({ memexId, docId: doc.id, sectionId: section.id, seq: 1, position: 1, body: "404 not 403" })
    .returning();
  await tagClause(memexId, clause.id, ["security"], vocab);
});

describe("facet gate — confirmatory pass (spec-340 t-7)", () => {
  it("surfaces the routed standards + an acknowledge prompt when facetAck is absent (ac-17, ac-19, ac-5)", async () => {
    tagAc(AC(17));
    tagAc(AC(19));
    tagAc(AC(5));
    const specId = await specInVerifyWithSecurityWork("spec-gate-a", false);
    const a = await assessPhaseTransition(memexId, specId, "done"); // no facetAck
    const gateNudge = a.nudges.find((n) => n.includes("Facet gate"));
    expect(gateNudge).toBeDefined();
    expect(gateNudge).toMatch(/std-sec7/); // the routed standard, named
    expect(gateNudge).toMatch(/against the ACTUAL diff/i); // re-check against the diff
    expect(gateNudge).toMatch(/facetAck/); // the acknowledge prompt
  });

  it("echoes an acknowledgment nudge when facetAck=true (ac-17)", async () => {
    tagAc(AC(17));
    const specId = await specInVerifyWithSecurityWork("spec-gate-b", false);
    const a = await assessPhaseTransition(memexId, specId, "done", undefined, true);
    const ack = a.nudges.find((n) => n.includes("acknowledged against the diff"));
    expect(ack).toBeDefined();
    expect(ack).toMatch(/std-sec7/);
    // and NOT the unacknowledged prompt
    expect(a.nudges.some((n) => n.includes("facetAck"))).toBe(false);
  });
});

describe("facet gate — predictive gap is advisory (spec-340 t-7)", () => {
  it("flags a task with no ballot, framed as advisory/non-blocking (ac-8)", async () => {
    tagAc(AC(8));
    const specId = await specInVerifyWithSecurityWork("spec-gate-c", true);
    const a = await assessPhaseTransition(memexId, specId, "done");
    const missing = a.nudges.find((n) => n.includes("no facet ballot"));
    expect(missing).toBeDefined();
    expect(missing).toMatch(/advisory|never blocks/i);
  });
});

describe("facet gate is non-blocking (spec-340 t-7)", () => {
  it("update_doc still advances the spec despite the hold nudges (ac-9, ac-8)", async () => {
    tagAc(AC(9));
    tagAc(AC(8));
    const specId = await specInVerifyWithSecurityWork("spec-gate-d", true);
    // The gate would hold (standards unacknowledged), but the transition is not blocked.
    const moved = await updateDocStatus(memexId, specId, "done");
    expect(moved.status).toBe("done");
  });
});
