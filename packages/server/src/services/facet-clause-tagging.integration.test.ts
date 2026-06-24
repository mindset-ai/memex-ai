// spec-340 t-12 — facets are required on add_clause (forced + rejection-rehand)
// and optional on edit_clause (remediation). The forcing/validation logic lives
// in validateClauseFacets; the handlers wire it (asserted by source).

import { describe, it, expect, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, isNull } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/connection.js";
import {
  standardClauseFacets,
  documents,
  docSections,
  standardClauses,
  namespaces,
  memexes,
} from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { seedDefaultFacets } from "./default-facets.js";
import { vocabForMemex, validateClauseFacets, tagClause } from "./facet-classifier.js";
import { ValidationError } from "../types/errors.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-340/acs/ac-${n}`;

let memexId: string;
let docId: string;
let sectionId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("fctag");
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  await seedDefaultFacets(row!.orgId!);
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "std-ct", title: "ct", docType: "standard", status: "approved" })
    .returning();
  docId = doc.id;
  const [section] = await db
    .insert(docSections)
    .values({ docId, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  sectionId = section.id;
});

async function newClause(seq: number): Promise<string> {
  const [cl] = await db
    .insert(standardClauses)
    .values({ memexId, docId, sectionId, seq, position: seq, body: `c${seq}` })
    .returning();
  return cl.id;
}

describe("validateClauseFacets — forced requirement + rejection-rehand (spec-340 t-12)", () => {
  it("rejects an absent verdict when required, re-handing valid keys + the facets list pointer (ac-27)", async () => {
    tagAc(AC(27));
    await expect(validateClauseFacets(memexId, undefined, { required: true })).rejects.toThrow(ValidationError);
    await expect(validateClauseFacets(memexId, undefined, { required: true })).rejects.toThrow(/security/); // a valid key handed back
    await expect(validateClauseFacets(memexId, undefined, { required: true })).rejects.toThrow(/facets tool/i); // points at the list tool
  });

  it("rejects an unknown facet slug, naming it (ac-27)", async () => {
    tagAc(AC(27));
    await expect(
      validateClauseFacets(memexId, ["security", "not-a-facet"], { required: true }),
    ).rejects.toThrow(/not-a-facet/);
  });

  it("accepts a valid verdict and accepts [] (no facets applicable) (ac-27)", async () => {
    tagAc(AC(27));
    expect((await validateClauseFacets(memexId, ["security"], { required: true })).length).toBe(16);
    expect((await validateClauseFacets(memexId, [], { required: true })).length).toBe(16); // [] is the honest escape
  });

  it("allows an absent verdict when NOT required — the edit_clause remediation path (ac-28)", async () => {
    tagAc(AC(28));
    expect((await validateClauseFacets(memexId, undefined, { required: false })).length).toBe(16); // no throw
  });
});

describe("validate → create/update → tag effect (spec-340 t-12)", () => {
  it("a valid verdict writes member tags; [] writes the explicit-none marker (ac-27)", async () => {
    tagAc(AC(27));
    const vocab = await vocabForMemex(memexId);

    const c1 = await newClause(10);
    await tagClause(memexId, c1, ["security", "db-migrations"], vocab);
    expect((await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, c1)))).toHaveLength(2);

    const c2 = await newClause(11);
    await tagClause(memexId, c2, [], vocab); // governs nothing
    const none = await db
      .select()
      .from(standardClauseFacets)
      .where(and(eq(standardClauseFacets.clauseId, c2), isNull(standardClauseFacets.facetId)));
    expect(none).toHaveLength(1);
  });

  it("edit re-tags only when a verdict is provided; omitted leaves tags unchanged (ac-28)", async () => {
    tagAc(AC(28));
    const vocab = await vocabForMemex(memexId);
    const c = await newClause(12);
    await tagClause(memexId, c, ["security"], vocab); // initial classification

    // edit with omitted facets → validate(required:false) returns vocab, handler does NOT tag.
    await validateClauseFacets(memexId, undefined, { required: false });
    let tags = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, c));
    expect(tags.filter((t) => t.facetId !== null)).toHaveLength(1); // unchanged

    // edit with a provided verdict → replace.
    await tagClause(memexId, c, ["architecture"], vocab);
    tags = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, c));
    expect(tags).toHaveLength(1);
    expect(tags[0].facetId).toBe(vocab.find((f) => f.key === "architecture")!.id);
  });
});

describe("the clause handlers wire the requirement (spec-340 t-12)", () => {
  it("add_clause validates required:true; edit_clause validates required:false (ac-27, ac-28)", () => {
    tagAc(AC(27));
    tagAc(AC(28));
    const src = readFileSync(join(__dirname, "..", "agent", "handlers", "sections.ts"), "utf8");
    expect(src).toMatch(/validateClauseFacets\(memexId, facets, \{ required: true \}\)/);
    expect(src).toMatch(/validateClauseFacets\(memexId, facets, \{ required: false \}\)/);
  });
});
