// spec-161 — clause-first standard authoring at the service level: a standard is born
// sectionless (ac-10), and a clause-first section persists one clause row per body with
// content = the clauses joined (ac-8). The doc-type gate itself is unit-tested in
// sections-write-gate.test.ts; this drives the underlying service path the tool uses.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, standardClauses } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { addClausesToSection } from "./clauses.js";
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

describe("spec-161: a standard is born sectionless (ac-10)", () => {
  it("createDocDraft with docType 'standard' creates zero body sections", async () => {
    tagAc(AC(10));
    const doc = await createDocDraft(memexId, "Sectionless Standard", "ignored purpose", "standard");
    createdDocIds.push(doc.id);

    const sections = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, doc.id));
    expect(sections).toHaveLength(0);
    expect(doc.handle).toMatch(/^std-\d+$/); // still a real standard with a std-N handle
  });

  it("a spec still gets its Overview first section (the gate is standard-only)", async () => {
    tagAc(AC(10));
    const doc = await createDocDraft(memexId, "A Spec", "the overview", "spec");
    createdDocIds.push(doc.id);
    const sections = await db.select().from(docSections).where(eq(docSections.docId, doc.id));
    expect(sections).toHaveLength(1);
  });
});

describe("spec-161: clause-first section persists clauses with content=join (ac-8)", () => {
  it("adds one clause row per body, in order, with content the clauses joined", async () => {
    tagAc(AC(8));
    const doc = await createDocDraft(memexId, "Authoring Standard", "x", "standard");
    createdDocIds.push(doc.id);

    // The clause-first write path the add_section tool uses: empty section, then clauses.
    const sectionMut = await addSection(memexId, doc.id, "rule", "", "Rule");
    const bodies = [
      "Every change ships with smoke tests.",
      "Smoke is green before prod.",
      "A check is a one-file diff.",
    ];
    const clauseMut = await addClausesToSection(memexId, sectionMut.id, bodies);

    expect(clauseMut).toHaveLength(3);
    // one row per body, in order
    const live = await db
      .select()
      .from(standardClauses)
      .where(and(eq(standardClauses.sectionId, sectionMut.id), ne(standardClauses.status, "deleted")))
      .orderBy(asc(standardClauses.position));
    expect(live.map((c) => c.body)).toEqual(bodies);
    // allocate-once seqs, contiguous from 1 on a fresh doc
    expect(live.map((c) => c.seq)).toEqual([1, 2, 3]);

    // section content === the clauses joined
    const section = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionMut.id) });
    expect(section!.content).toBe(bodies.join("\n\n"));
    expect(section!.preamble).toBeNull();
  });
});
