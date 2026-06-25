// spec-340 t-4 — the per-task forced full ballot at task creation. Validation
// (empty / contradiction / incomplete) is pure; storage + the front-load query
// run against a real Postgres.

import { describe, it, expect, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  taskFacetBallots,
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
import { createTask } from "./tasks.js";
import {
  validateBallot,
  castTaskBallot,
  ballotTrueFacets,
  clausesGoverningFacets,
  trueFacetsOf,
  type BallotInput,
} from "./facet-ballot.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let specDocId: string;
let vocab: VocabFacet[];

const allFalse = (v: VocabFacet[]): Record<string, boolean> =>
  Object.fromEntries(v.map((f) => [f.key, false]));

async function newTask(seq: number): Promise<string> {
  const [t] = await db
    .insert(tasks)
    .values({ memexId, docId: specDocId, seq, title: `t${seq}`, description: "d" })
    .returning();
  return t.id;
}

beforeAll(async () => {
  memexId = await makeTestMemex("fbal");
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  await seedDefaultFacets(row!.orgId!);
  vocab = await vocabForMemex(memexId);
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-bal", title: "ballot spec", docType: "spec", status: "build" })
    .returning();
  specDocId = doc.id;
});

describe("ballot validation (spec-340 t-4)", () => {
  it("rejects empty, contradiction, and incomplete; accepts a complete ballot or honest none (ac-22)", () => {
    tagAc(AC(22));
    // EMPTY — nothing adjudicated, not even none.
    expect(validateBallot({ verdict: {}, none: false }, vocab)).toMatchObject({ ok: false, reason: "empty" });
    // CONTRADICTION — none alongside a real facet.
    expect(
      validateBallot({ verdict: { ...allFalse(vocab), security: true }, none: true }, vocab),
    ).toMatchObject({ ok: false, reason: "contradiction" });
    // INCOMPLETE — a facet left un-adjudicated.
    const partial = { security: true }; // missing the other 15
    expect(validateBallot({ verdict: partial, none: false }, vocab)).toMatchObject({ ok: false, reason: "incomplete" });
    // ALL-FALSE without none → also empty (must declare none explicitly).
    expect(validateBallot({ verdict: allFalse(vocab), none: false }, vocab)).toMatchObject({ ok: false, reason: "empty" });

    // VALID — complete with ≥1 true.
    expect(validateBallot({ verdict: { ...allFalse(vocab), security: true }, none: false }, vocab)).toEqual({ ok: true });
    // VALID — honest none.
    expect(validateBallot({ verdict: allFalse(vocab), none: true }, vocab)).toEqual({ ok: true });
  });
});

describe("ballot capture (spec-340 t-4)", () => {
  it("stores the complete boolean map keyed on slug + extracts true facets; re-cast upserts (ac-3, ac-20)", async () => {
    tagAc(AC(3));
    tagAc(AC(20));
    const taskId = await newTask(1);
    await castTaskBallot(memexId, taskId, { verdict: { ...allFalse(vocab), security: true, "db-migrations": true }, none: false });

    const [stored] = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, taskId));
    // FULL map — all 16 adjudicated, not just the trues.
    expect(Object.keys(stored.verdict as Record<string, boolean>)).toHaveLength(16);
    expect((stored.vocabularyKeys as string[]).length).toBe(16);
    expect(await ballotTrueFacets(taskId)).toEqual(expect.arrayContaining(["security", "db-migrations"]));
    expect((await ballotTrueFacets(taskId)).length).toBe(2);

    // Re-cast → upsert in place (one ballot per task).
    await castTaskBallot(memexId, taskId, { verdict: { ...allFalse(vocab), architecture: true }, none: false });
    const rows = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, taskId));
    expect(rows).toHaveLength(1);
    expect(await ballotTrueFacets(taskId)).toEqual(["architecture"]);
  });

  it("stores explicit none as present-all-false (ac-21)", async () => {
    tagAc(AC(21));
    const taskId = await newTask(2);
    await castTaskBallot(memexId, taskId, { verdict: allFalse(vocab), none: true });
    const [stored] = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, taskId));
    expect(stored.none).toBe(true);
    expect(await ballotTrueFacets(taskId)).toEqual([]);
  });

  it("rejects an invalid ballot at cast time (ac-22)", async () => {
    tagAc(AC(22));
    const taskId = await newTask(3);
    await expect(castTaskBallot(memexId, taskId, { verdict: {}, none: false })).rejects.toThrow(/complete ballot/i);
    // …and no ballot row was written.
    const rows = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, taskId));
    expect(rows).toHaveLength(0);
  });
});

describe("ballot is advisory at task creation (spec-340 t-4)", () => {
  it("a task can be created with NO ballot — absence never blocks (ac-18)", async () => {
    tagAc(AC(18));
    const created = await createTask(memexId, specDocId, "no-ballot task", "d");
    expect(created.seq).toBeGreaterThan(0);
    const rows = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, created.id));
    expect(rows).toHaveLength(0); // predictive pass skipped, task still exists
  });
});

describe("front-load: clauses governing the task's facets (spec-340 t-4)", () => {
  it("returns the governing clauses for the ballot's true facets (ac-7)", async () => {
    tagAc(AC(7));
    // A standard with a security-governing clause.
    const [doc] = await db
      .insert(documents)
      .values({ memexId, handle: "std-frontload", title: "FL std", docType: "standard", status: "approved" })
      .returning();
    const [section] = await db
      .insert(docSections)
      .values({ docId: doc.id, sectionType: "rule", content: "x", seq: 1, position: 1 })
      .returning();
    const [clause] = await db
      .insert(standardClauses)
      .values({ memexId, docId: doc.id, sectionId: section.id, seq: 1, position: 1, body: "Return 404 not 403." })
      .returning();
    await tagClause(memexId, clause.id, ["security"], vocab);

    const ballot: BallotInput = { verdict: { ...allFalse(vocab), security: true }, none: false };
    const governing = await clausesGoverningFacets(memexId, trueFacetsOf(ballot, vocab));
    expect(governing.length).toBeGreaterThanOrEqual(1);
    expect(governing.some((c) => c.standardHandle === "std-frontload" && c.facetKey === "security")).toBe(true);
  });
});
