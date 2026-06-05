// spec-150 t-3 — the clause service against a real DB. Verifies clauses are
// first-class rows (ac-8), decomposition is doc_sections-count-neutral (ac-20), the
// section's content is the derived projection regenerated on clause change (ac-21),
// and clause identity is allocate-once: delete/insert never resequences (ac-11,
// ac-12).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, standardClauses } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { decomposeSection, createClause, updateClause, deleteClause } from "./clauses.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-150/acs/ac-${n}`;

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex();
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});

async function freshSection(content: string): Promise<{ docId: string; sectionId: string }> {
  const doc = await createDocDraft(memexId, "Clause Test Standard", "purpose");
  createdDocIds.push(doc.id);
  const section = await addSection(memexId, doc.id, "rule", content);
  return { docId: doc.id, sectionId: section.id };
}

async function sectionContent(sectionId: string): Promise<string> {
  const s = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
  return s!.content;
}

async function liveClauses(sectionId: string) {
  return db
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.sectionId, sectionId), ne(standardClauses.status, "deleted")));
}

describe("spec-150 t-3: decomposeSection", () => {
  it("creates one clause row per bullet, sets preamble, leaves content byte-identical (ac-8, ac-21)", async () => {
    tagAc(AC(8));
    tagAc(AC(21));
    const content = "Intro.\n\n- A\n- B\n";
    const { sectionId } = await freshSection(content);

    const result = await decomposeSection(memexId, sectionId);

    expect(result.clauses).toHaveLength(2);
    expect(result.clauses.map((c) => c.body)).toEqual(["- A\n", "- B\n"]);
    // Clauses are real rows with allocate-once seqs and a markdown body (ac-8).
    expect(result.clauses.every((c) => typeof c.seq === "number" && c.body.length > 0)).toBe(true);

    const s = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
    expect(s!.content).toBe(content); // byte-identical (ac-21)
    expect(s!.preamble).toBe("Intro.\n\n");
  });

  it("does not add or remove doc_sections rows (ac-20)", async () => {
    tagAc(AC(20));
    const { docId, sectionId } = await freshSection("Intro.\n\n- A\n- B\n- C\n");
    const before = (await db.select().from(docSections).where(eq(docSections.docId, docId))).length;
    await decomposeSection(memexId, sectionId);
    const after = (await db.select().from(docSections).where(eq(docSections.docId, docId))).length;
    expect(after).toBe(before);
    // ...and three clauses landed in the dedicated table instead.
    expect(await liveClauses(sectionId)).toHaveLength(3);
  });
});

describe("spec-150 t-3: content regenerates on clause change (ac-21)", () => {
  it("editing a clause body recomposes the section content", async () => {
    tagAc(AC(21));
    const { sectionId } = await freshSection("Intro.\n\n- A\n- B\n");
    const { clauses } = await decomposeSection(memexId, sectionId);
    await updateClause(memexId, clauses[0].id, "- A (edited)\n");
    expect(await sectionContent(sectionId)).toBe("Intro.\n\n- A (edited)\n- B\n");
  });
});

describe("spec-150 t-3: clause identity is allocate-once (ac-11, ac-12)", () => {
  it("appending a clause mints MAX(seq)+1 and leaves existing clause seqs untouched (ac-12)", async () => {
    tagAc(AC(12));
    const { sectionId } = await freshSection("Intro.\n\n- A\n- B\n");
    const { clauses } = await decomposeSection(memexId, sectionId);
    const seqsBefore = clauses.map((c) => c.seq);

    const created = await createClause(memexId, sectionId, "- C\n");
    expect(created.seq).toBe(Math.max(...seqsBefore) + 1);

    const after = await liveClauses(sectionId);
    const seqById = new Map(after.map((c) => [c.id, c.seq]));
    for (const c of clauses) expect(seqById.get(c.id)).toBe(c.seq); // unchanged
    expect(await sectionContent(sectionId)).toBe("Intro.\n\n- A\n- B\n- C\n");
  });

  it("deleting a clause freezes its seq and leaves siblings' seqs unchanged — no resequence (ac-11)", async () => {
    tagAc(AC(11));
    const { sectionId } = await freshSection("Intro.\n\n- A\n- B\n- C\n");
    const { clauses } = await decomposeSection(memexId, sectionId);

    await deleteClause(memexId, clauses[1].id); // delete B

    const live = await liveClauses(sectionId);
    expect(live).toHaveLength(2);
    const seqById = new Map(live.map((c) => [c.id, c.seq]));
    // A and C keep their original seqs — a gap is left where B was, no renumber.
    expect(seqById.get(clauses[0].id)).toBe(clauses[0].seq);
    expect(seqById.get(clauses[2].id)).toBe(clauses[2].seq);
    expect(await sectionContent(sectionId)).toBe("Intro.\n\n- A\n- C\n");
  });
});
