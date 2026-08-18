// spec-530 t-4 / dec-5 (ac-23) — clause order is a function of the rows, not of query luck.
//
// Two defects that compound, registered together as issue-1 during session 1:
//
//   1. `createClause` wrote the caller's `position` with no shift, so passing an
//      OCCUPIED ordinal produced two live rows sharing a position.
//   2. `liveClausesForSection` ordered by `position` alone, with no tiebreaker, so
//      tied rows came back in whatever order the scan produced.
//
// Together they meant a section's composed text was not a function of its rows:
// `regenerateSectionContentTx` joins the clauses in that order and writes the result
// to `doc_sections.content`, so a Standard's rendered rule text could change between
// two regenerations with no write in between.
//
// t-4's anchor→ordinal translation (ac-19) walks into defect 1 on EVERY `add`
// operation by construction — resolving an anchor to "just before/after cl-N" yields
// an ordinal that is already occupied; that is what "insert here" means.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, standardClauses } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { createClause, updateClause, deleteClause } from "./clauses.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_23 = "mindset-prod/memex-building-itself/specs/spec-530/acs/ac-23";

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("s530ord");
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});

/** A standard section carrying `bodies` as appended clauses — positions 1..N. */
async function seededSection(bodies: string[]): Promise<{ docId: string; sectionId: string }> {
  const doc = await createDocDraft(memexId, "Clause Order Standard", "purpose", "standard");
  createdDocIds.push(doc.id);
  const section = await addSection(memexId, doc.id, "rule", "");
  for (const body of bodies) {
    await createClause(memexId, section.id, body);
  }
  return { docId: doc.id, sectionId: section.id };
}

/** Live clauses as stored, read with an explicit total order so the ASSERTION never
 *  depends on the very ordering under test. */
async function liveRows(sectionId: string) {
  return db
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.sectionId, sectionId), ne(standardClauses.status, "deleted")))
    .orderBy(asc(standardClauses.position), asc(standardClauses.seq));
}

async function sectionContent(sectionId: string): Promise<string> {
  const row = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
  return row!.content;
}

describe("spec-530 dec-5: inserting at an occupied ordinal shifts, never ties (ac-23)", () => {
  it("shifts every live sibling at or after the target ordinal", async () => {
    tagAc(AC_23);
    const { sectionId } = await seededSection(["one", "two", "three", "four"]);

    await createClause(memexId, sectionId, "inserted", 2);

    const rows = await liveRows(sectionId);
    expect(rows.map((r) => r.body)).toEqual(["one", "inserted", "two", "three", "four"]);
    // Dense and unique — the property that makes "insert before cl-N" mean the same
    // thing to every caller.
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
  });

  it("composes the section in the shifted order, not the insertion order", async () => {
    tagAc(AC_23);
    const { sectionId } = await seededSection(["alpha", "beta"]);

    await createClause(memexId, sectionId, "wedged", 1);

    // The derived content is what a reader of the Standard actually sees.
    expect(await sectionContent(sectionId)).toBe("wedged\n\nalpha\n\nbeta");
  });

  it("a soft-deleted clause never consumes an ordinal in the shift", async () => {
    tagAc(AC_23);
    const { sectionId } = await seededSection(["keep-1", "doomed", "keep-2"]);
    const before = await liveRows(sectionId);
    await deleteClause(memexId, before[1].id);

    // Live rows are now keep-1 (1) and keep-2 (3) — the deleted row froze position 2.
    await createClause(memexId, sectionId, "inserted", 2);

    const rows = await liveRows(sectionId);
    expect(rows.map((r) => r.body)).toEqual(["keep-1", "inserted", "keep-2"]);
    expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
    // And the deleted clause is still absent from the rendered rule.
    expect(await sectionContent(sectionId)).not.toContain("doomed");
  });

  it("appending is unaffected — no position supplied still lands last", async () => {
    tagAc(AC_23);
    const { sectionId } = await seededSection(["first", "second"]);

    await createClause(memexId, sectionId, "appended");

    const rows = await liveRows(sectionId);
    expect(rows.map((r) => r.body)).toEqual(["first", "second", "appended"]);
    expect(rows[2].position).toBe(3);
  });
});

describe("spec-530 dec-5: rows already tied compose deterministically (ac-23)", () => {
  it("orders tied clauses by seq, so composition cannot follow scan order", async () => {
    tagAc(AC_23);
    const { docId, sectionId } = await seededSection(["anchor"]);

    // Two live rows sharing position 2 — the state no insert-side fix can retroactively
    // repair, because it already exists in databases written before dec-5.
    //
    // The seqs are deliberately INVERTED relative to insertion order: the row inserted
    // FIRST carries the HIGHER seq. So heap order (what an untied scan tends to return)
    // and seq order disagree, and only a real `ORDER BY position, seq` produces the
    // expected text. Without the tiebreaker this is exactly the coin-flip that let a
    // Standard's content change with no write behind it.
    await db.insert(standardClauses).values([
      { memexId, docId, sectionId, seq: 900, position: 2, body: "should-render-second" },
    ] as (typeof standardClauses.$inferInsert)[]);
    await db.insert(standardClauses).values([
      { memexId, docId, sectionId, seq: 800, position: 2, body: "should-render-first" },
    ] as (typeof standardClauses.$inferInsert)[]);

    // Force a regeneration through the ordinary path (editing an unrelated clause).
    const [anchor] = await liveRows(sectionId);
    await updateClause(memexId, anchor.id, "anchor");

    const content = await sectionContent(sectionId);
    expect(content).toBe("anchor\n\nshould-render-first\n\nshould-render-second");

    // And it is stable: a second regeneration produces the same bytes.
    await updateClause(memexId, anchor.id, "anchor");
    expect(await sectionContent(sectionId)).toBe(content);
  });
});
