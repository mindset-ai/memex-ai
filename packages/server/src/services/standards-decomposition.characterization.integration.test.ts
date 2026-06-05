// spec-150 t-1 — characterization: decomposition is byte-transparent over the REAL
// standards in this database.
//
// The transparency contract (ac-1, ac-2, ac-10) says decomposing a standard section
// into preamble + clauses must not change a single byte any consumer sees. The
// strongest evidence is the real corpus, not synthetic fixtures: this suite reads
// every live standard section and proves split -> compose reproduces it exactly, then
// drives a section's real content through the actual service path (addSection ->
// decomposeSection -> getDoc) and asserts the rendered content is unchanged.
//
// The round-trip check is READ-ONLY over live rows (no mutation of real standards);
// the end-to-end check uses a throwaway doc seeded with real content.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections } from "../db/schema.js";
import { createDocDraft, getDoc } from "./documents.js";
import { addSection } from "./sections.js";
import { decomposeSection } from "./clauses.js";
import { splitSectionIntoClauses, composeSectionContent } from "./clause-composition.js";
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

async function liveStandardSections(): Promise<{ id: string; content: string }[]> {
  return db
    .select({ id: docSections.id, content: docSections.content })
    .from(docSections)
    .innerJoin(documents, eq(docSections.docId, documents.id))
    .where(and(eq(documents.docType, "standard"), ne(docSections.status, "deleted")));
}

describe("spec-150 t-1: decomposition is byte-transparent over the real standards", () => {
  it("split -> compose round-trips byte-identically for EVERY live standard section (ac-10, ac-2)", async () => {
    tagAc(AC(10)); // export re-composed from preamble + clauses is byte-identical
    tagAc(AC(2)); // the embedding/FTS input (section content) is byte-identical
    const rows = await liveStandardSections();
    // Sanity: this DB actually contains standards to characterise against.
    expect(rows.length).toBeGreaterThan(0);

    const mismatches: { id: string; len: number }[] = [];
    for (const r of rows) {
      const { preamble, clauses } = splitSectionIntoClauses(r.content);
      const recomposed = composeSectionContent(
        preamble,
        clauses.map((body, i) => ({ position: i + 1, body })),
      );
      if (recomposed !== r.content) mismatches.push({ id: r.id, len: r.content.length });
    }
    // Every real standard section must recompose to the exact same bytes.
    expect(mismatches).toEqual([]);
  });

  it("getDoc content is byte-identical before and after decomposing a real-content section (ac-1)", async () => {
    tagAc(AC(1));
    // Seed a throwaway doc with the body of a real standard section — the messiest,
    // most realistic input — and decompose it through the live service path.
    const [sample] = await liveStandardSections();
    expect(sample).toBeTruthy();

    const doc = await createDocDraft(memexId, "char-test standard", "purpose");
    createdDocIds.push(doc.id);
    const section = await addSection(memexId, doc.id, "rule", sample.content);

    const before = (await getDoc(memexId, doc.id)).sections.find((s) => s.id === section.id)!;
    await decomposeSection(memexId, section.id);
    const after = (await getDoc(memexId, doc.id)).sections.find((s) => s.id === section.id)!;

    // The consumer-visible content (what export/FTS/admin read) is unchanged.
    expect(after.content).toBe(before.content);
    expect(after.content).toBe(sample.content);
  });
});
