// spec-340 t-3 — clause→facet classifier + pill rollup. The deterministic parts
// (tag persistence, the tri-state, the pill union) run against a real Postgres;
// the LLM is exercised only through an injected stub (no network, no key).

import { describe, it, expect, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  facets,
  standardClauseFacets,
  standardClauses,
  documents,
  docSections,
  namespaces,
  memexes,
} from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { seedDefaultFacets } from "./default-facets.js";
import {
  tagClause,
  standardPillSet,
  classifyStandard,
  classifyClauseWithLlm,
  vocabForMemex,
  type VocabFacet,
  type AnthropicLike,
} from "./facet-classifier.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let vocab: VocabFacet[];

async function makeStandardWithClauses(handle: string, bodies: string[]): Promise<{ docId: string; clauseIds: string[] }> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title: handle, docType: "standard", status: "approved" })
    .returning();
  const [section] = await db
    .insert(docSections)
    .values({ docId: doc.id, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  const clauseIds: string[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const [cl] = await db
      .insert(standardClauses)
      .values({ memexId, docId: doc.id, sectionId: section.id, seq: i + 1, position: i + 1, body: bodies[i] })
      .returning();
    clauseIds.push(cl.id);
  }
  return { docId: doc.id, clauseIds };
}

beforeAll(async () => {
  memexId = await makeTestMemex("fcls");
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  await seedDefaultFacets(row!.orgId!);
  vocab = await vocabForMemex(memexId);
  expect(vocab.length).toBe(16);
});

describe("tagClause + pill rollup (spec-340 t-3)", () => {
  it("writes member rows, an explicit-none marker, and rolls clauses up to a union pill set (ac-2)", async () => {
    tagAc(AC(2));
    const { docId, clauseIds } = await makeStandardWithClauses("std-pill", ["a", "b", "c"]);

    await tagClause(memexId, clauseIds[0], ["security", "code-style"], vocab);
    await tagClause(memexId, clauseIds[1], [], vocab); // explicit "governs nothing"
    await tagClause(memexId, clauseIds[2], ["security"], vocab);

    // clause[1] carries the none-marker (facet_id NULL), distinguishable from unclassified.
    const noneRows = await db
      .select()
      .from(standardClauseFacets)
      .where(and(eq(standardClauseFacets.clauseId, clauseIds[1]), isNull(standardClauseFacets.facetId)));
    expect(noneRows).toHaveLength(1);

    // The pill set is the UNION over MEMBER clauses only — the none-marker contributes nothing.
    const pills = await standardPillSet(memexId, docId);
    expect(pills).toEqual(["code-style", "security"]);
  });

  it("re-tagging a clause overwrites its prior verdict (idempotent) (ac-2)", async () => {
    tagAc(AC(2));
    const { clauseIds } = await makeStandardWithClauses("std-retag", ["a"]);
    await tagClause(memexId, clauseIds[0], ["security", "api-design"], vocab);
    await tagClause(memexId, clauseIds[0], ["architecture"], vocab);

    const rows = await db
      .select({ facetId: standardClauseFacets.facetId })
      .from(standardClauseFacets)
      .where(eq(standardClauseFacets.clauseId, clauseIds[0]));
    expect(rows).toHaveLength(1);
    const archId = vocab.find((f) => f.key === "architecture")!.id;
    expect(rows[0].facetId).toBe(archId);
  });
});

describe("classifyStandard orchestration (spec-340 t-3)", () => {
  it("classifies every clause and persists tags, with the LLM stubbed out (ac-2)", async () => {
    tagAc(AC(2));
    const { docId } = await makeStandardWithClauses("std-orch", [
      "All endpoints must return 404 not 403 for unauthorized resources.",
      "This rule exists because leaking existence is itself a disclosure.",
      "Every migration must enable row level security.",
    ]);

    // Deterministic stand-in for the model: keyword → facet keys; empty = none.
    const fakeClassify = (body: string): string[] => {
      if (body.includes("404")) return ["security", "api-design"];
      if (body.includes("migration")) return ["db-migrations", "security"];
      return []; // the rationale clause governs nothing
    };

    await classifyStandard(memexId, docId, { classify: fakeClassify });

    const pills = await standardPillSet(memexId, docId);
    expect(pills).toEqual(["api-design", "db-migrations", "security"]);

    // The rationale clause got an explicit-none marker (not left unclassified).
    const allRows = await db
      .select()
      .from(standardClauseFacets)
      .innerJoin(standardClauses, eq(standardClauseFacets.clauseId, standardClauses.id))
      .where(eq(standardClauses.docId, docId));
    const noneMarkers = allRows.filter((r) => r.standard_clause_facets.facetId === null);
    expect(noneMarkers).toHaveLength(1);
  });
});

describe("classifyClauseWithLlm structured output (spec-340 t-3)", () => {
  it("decodes the structured verdict and drops hallucinated slugs (ac-2)", async () => {
    tagAc(AC(2));
    const stub: AnthropicLike = {
      messages: {
        parse: async () => ({ parsed_output: { facetKeys: ["security", "not-a-real-facet"] } }),
      },
    };
    const keys = await classifyClauseWithLlm("some clause", vocab, { client: stub });
    expect(keys).toEqual(["security"]); // unknown slug filtered, never persisted
  });
});
