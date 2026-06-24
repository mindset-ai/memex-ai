// spec-340 t-10 — the canonical missed-standard case, end-to-end, with NO hooks.
//
// The lived failure (s-1): someone adds a user-facing button and never realises a
// Playwright-journey standard (std-28) governs it. This proves v1 catches it with
// MCP tools alone: the forced ballot surfaces the e2e-testing facet at task
// creation (front-load → the journey standard), and the verify gate re-confronts
// the same standard against the diff before done. Hooks would only move the catch
// earlier; they are not needed for correctness (dec-6).

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
import { castTaskBallot, clausesGoverningFacets, trueFacetsOf, type BallotInput } from "./facet-ballot.js";
import { evaluateFacetGate } from "./facet-gate.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let vocab: VocabFacet[];
const allFalse = (v: VocabFacet[]) => Object.fromEntries(v.map((f) => [f.key, false]));

beforeAll(async () => {
  memexId = await makeTestMemex("fcan");
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  await seedDefaultFacets(row!.orgId!);
  vocab = await vocabForMemex(memexId);

  // The std-28 analogue: a standard that mandates a Playwright journey for any
  // user-facing flow — governs the e2e-testing facet.
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "std-journey", title: "User-facing flows need a journey", docType: "standard", status: "approved" })
    .returning();
  const [section] = await db
    .insert(docSections)
    .values({ docId: doc.id, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  const [clause] = await db
    .insert(standardClauses)
    .values({
      memexId,
      docId: doc.id,
      sectionId: section.id,
      seq: 1,
      position: 1,
      body: "Every change that adds or alters a user-facing flow must add or extend an end-to-end journey.",
    })
    .returning();
  await tagClause(memexId, clause.id, ["e2e-testing"], vocab);
});

describe("the canonical button/std-28 miss is caught by v1 with no hooks (spec-340 t-10)", () => {
  it("surfaces the journey standard at task creation AND re-confronts it at the verify gate (ac-24, ac-7)", async () => {
    tagAc(AC(24));
    tagAc(AC(7));

    // A spec in build, and the offending task: "add a user-facing button".
    const [spec] = await db
      .insert(documents)
      .values({ memexId, handle: "spec-button", title: "Add a button", docType: "spec", status: "build" })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({ memexId, docId: spec.id, seq: 1, title: "Add a user-facing button", description: "new button in the toolbar" })
      .returning();

    // The forced ballot: the agent adjudicates every facet and marks e2e-testing.
    const ballot: BallotInput = { verdict: { ...allFalse(vocab), "e2e-testing": true }, none: false };
    await castTaskBallot(memexId, task.id, ballot);

    // CATCH #1 — at task creation, the front-load surfaces the journey standard.
    const frontLoad = await clausesGoverningFacets(memexId, trueFacetsOf(ballot, vocab));
    expect(frontLoad.some((c) => c.standardHandle === "std-journey")).toBe(true);

    // The spec advances to verify…
    await db.update(documents).set({ status: "verify" }).where(eq(documents.id, spec.id));

    // CATCH #2 — the verify gate re-confronts the SAME standard against the diff,
    // and (no facetAck) it holds, advisory, before done.
    const gate = await evaluateFacetGate(memexId, spec.id);
    expect(gate.standards.some((s) => s.handle === "std-journey")).toBe(true);
    expect(gate.ackPending).toBe(true); // must be acknowledged before done

    // Acknowledging clears the hold — the gate's only teeth.
    const acked = await evaluateFacetGate(memexId, spec.id, true);
    expect(acked.ackPending).toBe(false);
  });
});
