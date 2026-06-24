// spec-340 t-5 — routing (facet→standards stored-tag join), spec-level union,
// and the retained semantic-search backstop.

import { describe, it, expect, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { standardsForFacets, specFacetUnion, routeStandardsForSpec } from "./facet-routing.js";
import { searchMemex } from "./memex-search.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let vocab: VocabFacet[];
let specDocId: string;

const allFalse = (v: VocabFacet[]) => Object.fromEntries(v.map((f) => [f.key, false]));

async function standardWithClause(handle: string, title: string, facetKeys: string[]): Promise<void> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title, docType: "standard", status: "approved" })
    .returning();
  const [section] = await db
    .insert(docSections)
    .values({ docId: doc.id, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  const [clause] = await db
    .insert(standardClauses)
    .values({ memexId, docId: doc.id, sectionId: section.id, seq: 1, position: 1, body: `rule for ${handle}` })
    .returning();
  await tagClause(memexId, clause.id, facetKeys, vocab);
}

beforeAll(async () => {
  memexId = await makeTestMemex("frou");
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  await seedDefaultFacets(row!.orgId!);
  vocab = await vocabForMemex(memexId);

  await standardWithClause("std-sec", "Security standard", ["security"]);
  await standardWithClause("std-mig", "Migration standard", ["db-migrations"]);

  // A spec with two tasks carrying different ballots.
  const [spec] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-route", title: "route spec", docType: "spec", status: "build" })
    .returning();
  specDocId = spec.id;
  const [t1] = await db.insert(tasks).values({ memexId, docId: specDocId, seq: 1, title: "a", description: "d" }).returning();
  const [t2] = await db.insert(tasks).values({ memexId, docId: specDocId, seq: 2, title: "b", description: "d" }).returning();
  await castTaskBallot(memexId, t1.id, { verdict: { ...allFalse(vocab), security: true }, none: false });
  await castTaskBallot(memexId, t2.id, { verdict: { ...allFalse(vocab), "db-migrations": true }, none: false });
});

describe("facet→standards routing join (spec-340 t-5)", () => {
  it("resolves governing standards via the stored-tag join, deterministically (ac-11, ac-4)", async () => {
    tagAc(AC(11));
    tagAc(AC(4));
    const sec = await standardsForFacets(memexId, ["security"]);
    expect(sec.map((s) => s.handle)).toEqual(["std-sec"]);
    expect(sec[0].facetKeys).toEqual(["security"]);

    const both = await standardsForFacets(memexId, ["security", "db-migrations"]);
    expect(both.map((s) => s.handle)).toEqual(["std-mig", "std-sec"]);

    // Deterministic — same input, same output (no LLM, no embedding).
    const again = await standardsForFacets(memexId, ["security", "db-migrations"]);
    expect(again).toEqual(both);

    // A facet no clause governs surfaces nothing.
    expect(await standardsForFacets(memexId, ["accessibility"])).toEqual([]);
  });
});

describe("spec-level union aggregation (spec-340 t-5)", () => {
  it("a facet counts for the spec if ANY task's ballot asserts it (ac-14)", async () => {
    tagAc(AC(14));
    const union = await specFacetUnion(memexId, specDocId);
    expect(union).toEqual(["db-migrations", "security"]);
  });

  it("routeStandardsForSpec surfaces the standards governing the union (ac-4)", async () => {
    tagAc(AC(4));
    const routed = await routeStandardsForSpec(memexId, specDocId);
    expect(routed.map((s) => s.handle)).toEqual(["std-mig", "std-sec"]);
  });
});

describe("semantic search stays a non-exclusive backstop (spec-340 t-5)", () => {
  it("searchMemex remains callable, and routing is a join with no embedding on the hot path (ac-12)", () => {
    tagAc(AC(12));
    // The backstop is retained — the semantic search entrypoint still exists.
    expect(typeof searchMemex).toBe("function");
    // Routing is a pure DB join: the module IMPORTS no embedding/search/LLM path
    // (it stays a cheap join, never a per-call embedding query — ac-11).
    const src = readFileSync(join(__dirname, "facet-routing.ts"), "utf8");
    const imports = src.match(/^import .*$/gm)?.join("\n") ?? "";
    expect(imports).not.toMatch(/memex-search|embeddings|anthropic/i);
  });
});
