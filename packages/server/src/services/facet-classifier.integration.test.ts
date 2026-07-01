// spec-340 t-4 — the clause→facet classifier engine. DB-backed for the persistence +
// rollup; the LLM call is exercised through an injected stub (key-free) that captures
// the model + structured-output config and measures concurrency. Tags ac-39.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets, standardClauseFacets, namespaces, memexes, documents, docSections, standardClauses } from "../db/schema.js";
import {
  classifyStandard,
  backfillFacetTagsForMemex,
  standardPillSet,
  type AnthropicLike,
} from "./facet-classifier.js";
import { seedDefaultFacetsForOwner } from "./default-facets.js";
import { makeTestMemex } from "./test-helpers.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

async function orgIdFor(memexId: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (!row?.orgId) throw new Error("could not resolve org for test memex");
  return row.orgId;
}

let memexId: string;
let orgId: string;
let docId: string;
let sectionId: string;
const clauseIds: string[] = [];

async function addClause(body: string): Promise<string> {
  const [cl] = await db
    .insert(standardClauses)
    .values({ memexId, docId, sectionId, seq: clauseIds.length + 1, position: clauseIds.length + 1, body })
    .returning();
  clauseIds.push(cl.id);
  return cl.id;
}

beforeAll(async () => {
  memexId = await makeTestMemex("faccls");
  orgId = await orgIdFor(memexId);
  await seedDefaultFacetsForOwner({ ownerType: "org", ownerId: orgId });

  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "std-faccls", title: "Classifier test standard", docType: "standard", status: "approved" })
    .returning();
  docId = doc.id;
  const [section] = await db
    .insert(docSections)
    .values({ docId, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  sectionId = section.id;
  await addClause("All database access must enforce row-level security per tenant.");
  await addClause("This is a rationale clause that merely explains why; it governs nothing.");
  await addClause("Every endpoint must validate its input and return 404 (not 403) on unauthorized access.");
  await addClause("Use parameterized queries and never interpolate untrusted input.");
  await addClause("Prefer small focused files over large ones.");
});

afterAll(async () => {
  await db.delete(standardClauseFacets).where(eq(standardClauseFacets.memexId, memexId)).catch(() => {});
  await db.delete(facets).where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId))).catch(() => {});
  if (docId) await db.delete(documents).where(eq(documents.id, docId)).catch(() => {});
});

describe("facet classifier engine (spec-340 t-4)", () => {
  it("uses claude-opus-4-8 + Anthropic structured output, and classifies clauses in bounded-parallel (ac-39)", async () => {
    tagAc(AC(39));
    const seenModels: string[] = [];
    let sawStructuredFormat = false;
    let inFlight = 0;
    let maxInFlight = 0;

    const stub: AnthropicLike = {
      messages: {
        parse: async (args: { model: string; output_config?: { format?: unknown } }) => {
          seenModels.push(args.model);
          if (args.output_config?.format) sawStructuredFormat = true;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          inFlight--;
          // structured output: the SDK returns the validated object on parsed_output —
          // no raw JSON parsing by the caller.
          return { parsed_output: { facetKeys: ["security"] } };
        },
      },
    };

    await classifyStandard(memexId, docId, { client: stub });

    // One call per clause, every call on the coding-agent model.
    expect(seenModels.length).toBe(clauseIds.length);
    expect(new Set(seenModels)).toEqual(new Set(["claude-opus-4-8"]));
    // Structured output, not raw JSON parsing.
    expect(sawStructuredFormat).toBe(true);
    // Parallel (more than one in flight at once) but bounded (never all five — the
    // pool caps concurrency; with 5 clauses and a cap of 8 it would be 5, so assert
    // it actually ran concurrently rather than serially).
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("persists the tri-state via the deterministic classify seam (governs / explicit-none) (ac-39)", async () => {
    tagAc(AC(39));
    // A deterministic classifier: clause body decides its facets — no LLM.
    const classify = (body: string): string[] => {
      if (body.includes("row-level security")) return ["security", "db-migrations"];
      if (body.includes("rationale")) return []; // governs nothing → explicit-none
      if (body.includes("404")) return ["security", "api-design"];
      if (body.includes("parameterized")) return ["security"];
      return []; // "small focused files" → code-style in reality, but [] exercises explicit-none too
    };
    await classifyStandard(memexId, docId, { classify });

    // clause[0] → two member rows (security, db-migrations).
    const c0 = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, clauseIds[0]));
    expect(c0.length).toBe(2);
    expect(c0.every((r) => r.facetId !== null)).toBe(true);

    // clause[1] (rationale) → exactly one explicit-none marker (facet_id NULL).
    const c1 = await db
      .select()
      .from(standardClauseFacets)
      .where(and(eq(standardClauseFacets.clauseId, clauseIds[1]), isNull(standardClauseFacets.facetId)));
    expect(c1.length).toBe(1);

    // The standard's pill set is the UNION of member keys (explicit-none excluded).
    const pills = await standardPillSet(memexId, docId);
    expect(pills).toEqual(["api-design", "db-migrations", "security"]);
  });

  it("backfill tags every ballotless clause, none left unclassified, idempotent (ac-39, spec-437 ac-4/ac-11)", async () => {
    tagAc(AC(39));
    // spec-437 dec-3: the facet backfill RIDES this spec-340 harness. Every pre-existing
    // ballotless clause (all five start untagged here) is tagged a deliberate verdict —
    // member rows or the governs-nothing marker — leaving ZERO clauses in an absent state;
    // the idempotent re-run respects already-tagged clauses (the gap discipline).
    tagAc("mindset-prod/memex-building-itself/specs/spec-437/acs/ac-4");
    tagAc("mindset-prod/memex-building-itself/specs/spec-437/acs/ac-11");
    const classify = (body: string): string[] => (body.includes("rationale") ? [] : ["security"]);

    const first = await backfillFacetTagsForMemex(memexId, { classify });
    expect(first.standards).toBeGreaterThanOrEqual(1);
    expect(first.clauses).toBe(clauseIds.length);

    // Every clause now carries exactly one row (member or none-marker) — none left
    // not-yet-classified. This is dec-3 ac-11: zero clauses remain in an absent verdict.
    const after = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.memexId, memexId));
    const byClause = new Map<string, number>();
    for (const r of after) byClause.set(r.clauseId, (byClause.get(r.clauseId) ?? 0) + 1);
    for (const id of clauseIds) expect(byClause.get(id)).toBeGreaterThanOrEqual(1);
    // No seeded clause is absent from the tag table at all.
    expect(clauseIds.every((id) => byClause.has(id))).toBe(true);

    // Idempotent: a second run replaces, doesn't duplicate — clause[0] still has 1 row.
    await backfillFacetTagsForMemex(memexId, { classify });
    const c0 = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, clauseIds[0]));
    expect(c0.length).toBe(1);
  });

  it("retries a transient blip and still tags every clause — one 429 never aborts the run (ac-39)", async () => {
    tagAc(AC(39));
    // The first parse call across the whole run throws a 429; the pool must retry it
    // (backoff) and complete rather than abort — the robustness a long backfill needs.
    let calls = 0;
    let threwOnce = false;
    const stub: AnthropicLike = {
      messages: {
        parse: async () => {
          calls++;
          if (!threwOnce) {
            threwOnce = true;
            throw Object.assign(new Error("overloaded"), { status: 429 });
          }
          return { parsed_output: { facetKeys: ["security"] } };
        },
      },
    };

    await classifyStandard(memexId, docId, { client: stub });

    // One retry = exactly one extra call beyond the clause count, and every clause tagged.
    expect(calls).toBe(clauseIds.length + 1);
    const rows = await db
      .select()
      .from(standardClauseFacets)
      .where(eq(standardClauseFacets.memexId, memexId));
    const tagged = new Set(rows.map((r) => r.clauseId));
    for (const id of clauseIds) expect(tagged.has(id)).toBe(true);
  });

  it("does NOT retry a non-transient error — it surfaces and aborts (ac-39)", async () => {
    tagAc(AC(39));
    const stub: AnthropicLike = {
      messages: {
        parse: async () => {
          throw Object.assign(new Error("bad request"), { status: 400 });
        },
      },
    };
    await expect(classifyStandard(memexId, docId, { client: stub })).rejects.toThrow();
  });

  it("retries a null/non-conforming structured output then succeeds — a bad LLM response never aborts (ac-39)", async () => {
    tagAc(AC(39));
    // The first parse returns NO parsed_output (the failure mode that killed the prod
    // backfill). It must be re-asked, not thrown straight through.
    let nulledOnce = false;
    const stub: AnthropicLike = {
      messages: {
        parse: async () => {
          if (!nulledOnce) {
            nulledOnce = true;
            return { parsed_output: null };
          }
          return { parsed_output: { facetKeys: ["security"] } };
        },
      },
    };
    await classifyStandard(memexId, docId, { client: stub });
    const rows = await db
      .select()
      .from(standardClauseFacets)
      .where(eq(standardClauseFacets.memexId, memexId));
    const tagged = new Set(rows.map((r) => r.clauseId));
    for (const id of clauseIds) expect(tagged.has(id)).toBe(true);
  });

  it("tolerates a clause that persistently fails — skips + reports it, classifies the rest (ac-39)", async () => {
    tagAc(AC(39));
    // One clause always errors non-transiently; with onClauseError the run skips it
    // (no row written) and continues instead of aborting the whole backfill.
    // Start clean — earlier tests in this file tag these shared clauses.
    await db.delete(standardClauseFacets).where(eq(standardClauseFacets.memexId, memexId));
    const poison = "Use parameterized queries and never interpolate untrusted input.";
    const stub: AnthropicLike = {
      messages: {
        parse: async (args: { messages: { content: string }[] }) => {
          if (args.messages[0].content.includes(poison)) {
            throw Object.assign(new Error("bad request"), { status: 400 });
          }
          return { parsed_output: { facetKeys: ["security"] } };
        },
      },
    };
    const failed: string[] = [];
    await classifyStandard(memexId, docId, {
      client: stub,
      onClauseError: (clauseId) => failed.push(clauseId),
    });
    // Exactly the one poison clause was reported, and it carries no tag row…
    expect(failed.length).toBe(1);
    const poisonRows = await db
      .select()
      .from(standardClauseFacets)
      .where(eq(standardClauseFacets.clauseId, failed[0]));
    expect(poisonRows.length).toBe(0);
    // …while the others were classified.
    const tagged = new Set(
      (await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.memexId, memexId))).map(
        (r) => r.clauseId,
      ),
    );
    expect([...tagged].length).toBeGreaterThanOrEqual(clauseIds.length - 1);
  });
});
