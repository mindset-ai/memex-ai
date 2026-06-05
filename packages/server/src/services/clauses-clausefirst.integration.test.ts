// spec-161 — the clause service on CLAUSE-FIRST standard sections (preamble null),
// the model standards are authored under going forward. Verifies the content=join
// invariant (ac-12) and allocate-once clause identity (ac-13). The legacy
// preamble+compose path keeps its own coverage in clauses.integration.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, standardClauses } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { createClause, updateClause, deleteClause } from "./clauses.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-161/acs/ac-${n}`;

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

// A clause-first standard section: born via addSection (preamble null). The seed body
// is overwritten by content=join on the first clause write.
async function freshClauseFirstSection(): Promise<{ docId: string; sectionId: string }> {
  const doc = await createDocDraft(memexId, "Clause-first Standard", "purpose", "standard");
  createdDocIds.push(doc.id);
  const section = await addSection(memexId, doc.id, "rule", "seed");
  return { docId: doc.id, sectionId: section.id };
}

async function sectionContent(sectionId: string): Promise<string> {
  const s = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
  return s!.content;
}

async function preamble(sectionId: string): Promise<string | null> {
  const s = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
  return s!.preamble;
}

async function liveClauses(sectionId: string) {
  return db
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.sectionId, sectionId), ne(standardClauses.status, "deleted")))
    .orderBy(asc(standardClauses.position));
}

describe("spec-161: content=join invariant on clause-first sections (ac-12)", () => {
  it("create / edit / delete each leave content === the ordered join of live clauses", async () => {
    tagAc(AC(12));
    const { sectionId } = await freshClauseFirstSection();

    const a = await createClause(memexId, sectionId, "Clause A.");
    const b = await createClause(memexId, sectionId, "Clause B.");
    expect(await sectionContent(sectionId)).toBe("Clause A.\n\nClause B.");
    expect(await preamble(sectionId)).toBeNull(); // stays clause-first, no preamble

    await updateClause(memexId, a.id, "Clause A (edited).");
    expect(await sectionContent(sectionId)).toBe("Clause A (edited).\n\nClause B.");

    await deleteClause(memexId, b.id);
    expect(await sectionContent(sectionId)).toBe("Clause A (edited).");

    // content is exactly the join of what's live, always.
    const live = await liveClauses(sectionId);
    expect(await sectionContent(sectionId)).toBe(live.map((c) => c.body).join("\n\n"));
  });
});

describe("spec-161: allocate-once clause identity on clause-first sections (ac-13)", () => {
  it("append mints MAX(seq)+1 and leaves existing clause seqs untouched", async () => {
    tagAc(AC(13));
    const { sectionId } = await freshClauseFirstSection();
    const a = await createClause(memexId, sectionId, "A.");
    const b = await createClause(memexId, sectionId, "B.");

    const c = await createClause(memexId, sectionId, "C.");
    expect(c.seq).toBe(Math.max(a.seq, b.seq) + 1);

    const seqById = new Map((await liveClauses(sectionId)).map((x) => [x.id, x.seq]));
    expect(seqById.get(a.id)).toBe(a.seq);
    expect(seqById.get(b.id)).toBe(b.seq);
  });

  it("delete soft-deletes and never resequences surviving clauses", async () => {
    tagAc(AC(13));
    const { sectionId } = await freshClauseFirstSection();
    const a = await createClause(memexId, sectionId, "A.");
    const b = await createClause(memexId, sectionId, "B.");
    const c = await createClause(memexId, sectionId, "C.");

    await deleteClause(memexId, b.id);

    const live = await liveClauses(sectionId);
    expect(live).toHaveLength(2);
    const seqById = new Map(live.map((x) => [x.id, x.seq]));
    expect(seqById.get(a.id)).toBe(a.seq); // unchanged
    expect(seqById.get(c.id)).toBe(c.seq); // no renumber into B's freed seq
    expect(seqById.has(b.id)).toBe(false);
  });
});
