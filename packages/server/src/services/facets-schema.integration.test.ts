// spec-340 t-1 — schema shape for the facet substrate (facets, clause→facet
// tags, per-task ballots). DB-backed: the constraints (per-org uniqueness, the
// clause-tag tri-state, the ballot's complete-map + explicit-none) are enforced
// by Postgres, so a pure unit test on the Drizzle objects could pass while the
// migration is wrong. Each `it` tags the implementation AC it proves.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  facets,
  standardClauseFacets,
  taskFacetBallots,
  namespaces,
  memexes,
  documents,
  docSections,
  standardClauses,
  tasks,
} from "../db/schema.js";
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
let orgId2: string;
let docId: string;
const clauseIds: string[] = [];
let taskId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("fac");
  orgId = await orgIdFor(memexId);
  // A second org to prove facet keys are unique PER ORG, not globally.
  orgId2 = await orgIdFor(await makeTestMemex("fac2"));

  // A standard doc + section + three clauses to hang clause→facet tags on.
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "std-fac", title: "Facet test standard", docType: "standard", status: "approved" })
    .returning();
  docId = doc.id;
  const [section] = await db
    .insert(docSections)
    .values({ docId, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  for (let i = 0; i < 3; i++) {
    const [cl] = await db
      .insert(standardClauses)
      .values({ memexId, docId, sectionId: section.id, seq: i + 1, position: i + 1, body: `clause ${i}` })
      .returning();
    clauseIds.push(cl.id);
  }

  // A task to hang a ballot on.
  const [specDoc] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-fac", title: "Facet test spec", docType: "spec", status: "build" })
    .returning();
  const [task] = await db
    .insert(tasks)
    .values({ memexId, docId: specDoc.id, seq: 1, title: "t", description: "d" })
    .returning();
  taskId = task.id;
});

afterAll(async () => {
  await db.delete(taskFacetBallots).where(eq(taskFacetBallots.memexId, memexId)).catch(() => {});
  await db.delete(standardClauseFacets).where(eq(standardClauseFacets.memexId, memexId)).catch(() => {});
  await db.delete(facets).where(eq(facets.orgId, orgId)).catch(() => {});
  await db.delete(facets).where(eq(facets.orgId, orgId2)).catch(() => {});
  if (docId) await db.delete(documents).where(eq(documents.id, docId)).catch(() => {});
});

describe("facets vocabulary table (spec-340 t-1)", () => {
  it("is org-scoped with per-org (not global) key uniqueness — two orgs share a key, one org can't duplicate it (ac-25)", async () => {
    tagAc(AC(25));
    // Same key under two different orgs — must BOTH succeed (no global unique).
    await db.insert(facets).values({ orgId, key: "security", description: "authz/tenancy/secrets" });
    await db.insert(facets).values({ orgId: orgId2, key: "security", description: "authz/tenancy/secrets" });

    const rows = await db.select().from(facets).where(eq(facets.key, "security"));
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.orgId))).toEqual(new Set([orgId, orgId2]));

    // Duplicate (org_id, key) — must violate facets_org_id_key_unique.
    await expect(
      db.insert(facets).values({ orgId, key: "security", description: "dup" }),
    ).rejects.toThrow();
  });
});

describe("clause→facet tags — the tri-state (spec-340 t-1)", () => {
  it("distinguishes governs-facet, explicit-none, and not-yet-classified (ac-2)", async () => {
    tagAc(AC(2));
    const [secFacet] = await db
      .insert(facets)
      .values({ orgId, key: "sec-tag", description: "x" })
      .returning();

    // clause[0] governs a facet (member row).
    await db.insert(standardClauseFacets).values({ memexId, clauseId: clauseIds[0], facetId: secFacet.id });
    // clause[1] is explicitly classified as governing nothing (facet_id NULL).
    await db.insert(standardClauseFacets).values({ memexId, clauseId: clauseIds[1], facetId: null });
    // clause[2] has NO rows → not-yet-classified.

    const member = await db
      .select()
      .from(standardClauseFacets)
      .where(and(eq(standardClauseFacets.clauseId, clauseIds[0]), eq(standardClauseFacets.facetId, secFacet.id)));
    expect(member.length).toBe(1);

    const noneMarker = await db
      .select()
      .from(standardClauseFacets)
      .where(and(eq(standardClauseFacets.clauseId, clauseIds[1]), isNull(standardClauseFacets.facetId)));
    expect(noneMarker.length).toBe(1); // explicit "governs nothing"

    const unclassified = await db
      .select()
      .from(standardClauseFacets)
      .where(eq(standardClauseFacets.clauseId, clauseIds[2]));
    expect(unclassified.length).toBe(0); // not-yet-classified — absence of any row
  });

  it("enforces at-most-one none-marker and at-most-one membership per (clause,facet) (ac-2)", async () => {
    tagAc(AC(2));
    const [f] = await db.insert(facets).values({ orgId, key: "dup-tag", description: "x" }).returning();
    await db.insert(standardClauseFacets).values({ memexId, clauseId: clauseIds[0], facetId: f.id });
    // duplicate membership → partial unique violation
    await expect(
      db.insert(standardClauseFacets).values({ memexId, clauseId: clauseIds[0], facetId: f.id }),
    ).rejects.toThrow();
    // second none-marker on clause[1] (already has one) → partial unique violation
    await expect(
      db.insert(standardClauseFacets).values({ memexId, clauseId: clauseIds[1], facetId: null }),
    ).rejects.toThrow();
  });
});

describe("per-task ballot — complete map + explicit none (spec-340 t-1)", () => {
  it("persists the full boolean map keyed on slug, one ballot per task (ac-3, ac-20)", async () => {
    tagAc(AC(3));
    tagAc(AC(20));
    const verdict = { security: true, "e2e-testing": false, "code-style": false };
    await db.insert(taskFacetBallots).values({
      memexId,
      taskId,
      verdict,
      none: false,
      vocabularyKeys: Object.keys(verdict),
    });

    const [stored] = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, taskId));
    // FULL map persisted — every adjudicated facet present, not just the trues.
    expect(stored.verdict).toEqual(verdict);
    expect(Object.keys(stored.verdict as Record<string, boolean>)).toHaveLength(3);

    // One ballot per task.
    await expect(
      db.insert(taskFacetBallots).values({ memexId, taskId, verdict, none: false, vocabularyKeys: [] }),
    ).rejects.toThrow();
  });

  it("represents explicit none (present-all-false) distinguishably from not-yet-classified (absent) (ac-21)", async () => {
    tagAc(AC(21));
    // A fresh task with an explicit-none ballot.
    const [specDoc] = await db
      .insert(documents)
      .values({ memexId, handle: "spec-none", title: "none spec", docType: "spec", status: "build" })
      .returning();
    const [noneTask] = await db
      .insert(tasks)
      .values({ memexId, docId: specDoc.id, seq: 1, title: "n", description: "d" })
      .returning();
    await db.insert(taskFacetBallots).values({
      memexId,
      taskId: noneTask.id,
      verdict: { security: false, "e2e-testing": false },
      none: true,
      vocabularyKeys: ["security", "e2e-testing"],
    });

    // Another task with NO ballot row at all.
    const [unTask] = await db
      .insert(tasks)
      .values({ memexId, docId: specDoc.id, seq: 2, title: "u", description: "d" })
      .returning();

    const [explicitNone] = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, noneTask.id));
    expect(explicitNone).toBeDefined(); // record present → classified
    expect(explicitNone.none).toBe(true); // honest no-facet work

    const absent = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, unTask.id));
    expect(absent.length).toBe(0); // record absent → not-yet-classified

    await db.delete(documents).where(eq(documents.id, specDoc.id)).catch(() => {});
  });
});
