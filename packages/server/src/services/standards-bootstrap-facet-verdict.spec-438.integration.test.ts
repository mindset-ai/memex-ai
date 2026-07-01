// spec-438 t-6 (ac-3, facet half): each clause the bootstrap authors carries a
// DELIBERATE facet verdict via spec-437's now-live ballot — closing the spike's
// one real gap (clauses landed facet-untagged because the bulk path skipped the
// ballot). The load-bearing nuance: the ballot self-disables when the Memex has
// NO facet vocabulary, and cold-start is the no-vocab case by nature — but memex/
// org creation seeds the default vocabulary, so the common cold-start path DOES
// have one and the ballot enforces. This test proves both halves against a real DB.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, standardClauseFacets } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { seedDefaultFacetsForMemexBestEffort } from "./default-facets.js";
import { validateClauseFacetsBatch } from "./facet-vocab.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { addClausesToSection } from "./clauses.js";
import { fetchTopic } from "./guidance.js";
import { ValidationError } from "../types/errors.js";

const AC3 = "mindset-prod/memex-building-itself/specs/spec-438/acs/ac-3";
const here = dirname(fileURLToPath(import.meta.url));
const createdDocIds: string[] = [];

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

// A raw makeTestMemex is an org-memex WITHOUT the default facets (it inserts rows
// directly) — the bare cold-start state BEFORE the seeder runs. `seededMemexId`
// then models real cold-start: memex/org creation seeds the default vocabulary.
// The suite-wide MEMEX_DEFAULT_FACETS_SEED=off gate (vitest.config.ts) is toggled
// off around the seed exactly as the autoseed integration test does, then restored
// (std-37: restore global stubs).
let bareMemexId: string;
let seededMemexId: string;
beforeAll(async () => {
  bareMemexId = await makeTestMemex("boot438bare");
  seededMemexId = await makeTestMemex("boot438seeded");
  const savedGate = process.env.MEMEX_DEFAULT_FACETS_SEED;
  delete process.env.MEMEX_DEFAULT_FACETS_SEED;
  try {
    await seedDefaultFacetsForMemexBestEffort(seededMemexId);
  } finally {
    if (savedGate === undefined) delete process.env.MEMEX_DEFAULT_FACETS_SEED;
    else process.env.MEMEX_DEFAULT_FACETS_SEED = savedGate;
  }
});

describe("spec-438 t-6 — bootstrap clauses carry a deliberate facet verdict at cold-start (ac-3)", () => {
  it("the ballot self-disables with NO vocabulary — the nuance cold-start must beat", async () => {
    tagAc(AC3);
    // no vocabulary yet → every verdict resolves to null (nothing required). This
    // is exactly why the target Memex's vocabulary must be guaranteed present.
    const resolved = await validateClauseFacetsBatch(bareMemexId, [undefined]);
    expect(resolved).toEqual([null]);
  });

  it("with the default vocabulary seeded (as memex/org creation does), the ballot ENFORCES", async () => {
    tagAc(AC3);
    // an ABSENT verdict is now rejected — a clause cannot land ballotless.
    await expect(validateClauseFacetsBatch(seededMemexId, [undefined])).rejects.toBeInstanceOf(
      ValidationError,
    );
    // a deliberate verdict resolves to the facet id; the explicit "governs
    // nothing" marker ([]) resolves to [] — both are deliberate, neither absent.
    const resolved = await validateClauseFacetsBatch(seededMemexId, [["security"], []]);
    expect(resolved[0]).toHaveLength(1);
    expect(resolved[1]).toEqual([]);
  });

  it("clauses authored through the bulk path persist their deliberate facet verdict", async () => {
    tagAc(AC3);
    const doc = await createDocDraft(seededMemexId, "Cold-start discovered", "", "standard");
    createdDocIds.push(doc.id);
    const sec = await addSection(seededMemexId, doc.id, "rule", "placeholder", "Rule");
    const clauses = await addClausesToSection(seededMemexId, sec.id, [
      { body: "Secrets are read from the environment, never committed.", facets: ["security"] },
      { body: "This rationale governs no practice area.", facets: [] },
    ]);
    const ids = clauses.map((c) => c.id);
    const facetRows = await db
      .select()
      .from(standardClauseFacets)
      .where(inArray(standardClauseFacets.clauseId, ids));
    // EVERY authored clause carries a ballot row — a facet id for the security
    // clause, and the explicit governs-nothing marker (facetId NULL) for the
    // rationale clause. No clause is ballotless.
    expect(facetRows.length).toBe(2);
    const byClause = new Map(facetRows.map((r) => [r.clauseId, r.facetId]));
    expect(byClause.get(ids[0])).toBeTruthy(); // security → a real facet id
    expect(byClause.get(ids[1])).toBeNull(); // [] → deliberate governs-nothing
  });

  it("memex/org creation wires the default-facet seeder, so a cold-start Memex has a vocabulary", () => {
    tagAc(AC3);
    const orgs = readFileSync(join(here, "orgs.ts"), "utf8");
    const userNs = readFileSync(join(here, "user-namespaces.ts"), "utf8");
    expect(orgs).toMatch(/seedDefaultFacets/);
    expect(userNs).toMatch(/seedDefaultFacets/);
  });

  it("the protocol mandates evidence, no invention, admin acceptance, and a deliberate facet verdict per clause (ac-3)", async () => {
    tagAc(AC3);
    const { body } = await fetchTopic("standards-bootstrap");
    expect(body).toMatch(/cit(e|ation)/i); // evidence-backed
    expect(body).toMatch(/never invent|do not invent/i); // never invented
    expect(body).toMatch(/only after a clear yes|admin|accept/i); // admin-accepted
    expect(body).toMatch(/deliberate facet verdict/i); // a deliberate verdict per clause
  });
});
