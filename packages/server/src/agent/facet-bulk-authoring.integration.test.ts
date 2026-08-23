// spec-437 dec-1 — the facet ballot is enforced on the BULK clause path (add_section's
// clauses / addClausesToSection), not just add_clause. An absent verdict is rejected when
// the Memex has a vocabulary; an explicit [] is the deliberate "governs nothing" marker.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  docSections,
  standardClauses,
  standardClauseFacets,
  facets,
} from "../db/schema.js";
import { executeServerTool } from "./tools.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-437";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let userId: string;
let memexId: string;
let nsSlug: string;
let docRef: string;
const facetId = new Map<string, string>();

beforeAll(async () => {
  const sub = `s437-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as never).returning();
  userId = u.id;
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  nsSlug = ns.slug;
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
  memexId = mx.id;
  await db.insert(orgMemberships).values({ userId, orgId: org.id, role: "administrator" });

  for (const key of ["xd-security", "xd-perf"]) {
    const [f] = await db
      .insert(facets)
      .values({ ownerType: "org", ownerId: org.id, key, description: key })
      .returning();
    facetId.set(key, f.id);
  }

  await db
    .insert(documents)
    .values({ memexId, handle: "std-1", title: "A standard", docType: "standard", status: "draft" });
  docRef = `${nsSlug}/main/standards/std-1`;
});

afterAll(async () => {
  await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
  await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

async function clauseIdsForSection(sectionType: string): Promise<string[]> {
  const [sec] = await db
    .select({ id: docSections.id })
    .from(docSections)
    .innerJoin(documents, eq(documents.id, docSections.docId))
    .where(and(eq(documents.memexId, memexId), eq(docSections.sectionType, sectionType)));
  const rows = await db
    .select({ id: standardClauses.id })
    .from(standardClauses)
    .where(eq(standardClauses.sectionId, sec.id))
    .orderBy(standardClauses.position);
  return rows.map((r) => r.id);
}

describe("add_section bulk path enforces the facet ballot (spec-437 dec-1)", () => {
  it("rejects bulk clauses with an absent verdict when a vocabulary exists (ac-5, ac-1)", async () => {
    tagAc(AC(5));
    tagAc(AC(1)); // scope: no clause on any path without a deliberate verdict
    await expect(
      executeServerTool(
        memexId,
        "add_section",
        { ref: docRef, sectionType: "rule", clauses: ["a rule", "another"] },
        userId,
      ),
    ).rejects.toThrow(/facet verdict|xd-security/);
  });

  it("rejects an unknown facet key in the bulk verdict (ac-5)", async () => {
    tagAc(AC(5));
    await expect(
      executeServerTool(
        memexId,
        "add_section",
        { ref: docRef, sectionType: "rule2", clauses: ["a rule"], clauseFacets: [["made-up"]] },
        userId,
      ),
      // spec-514 dec-2 widened this message: the bulk path now names the offending
      // clause by its 1-based position, so the agent knows WHICH verdict to fix.
    ).rejects.toThrow(/Clause 1 names unknown facet key/);
  });

  it("accepts per-clause verdicts and persists them; [] is the governs-nothing marker (ac-5, ac-6)", async () => {
    tagAc(AC(5));
    tagAc(AC(6));
    await executeServerTool(
      memexId,
      "add_section",
      {
        ref: docRef,
        sectionType: "rule3",
        clauses: ["auth rule", "a definition"],
        clauseFacets: [["xd-security"], []],
      },
      userId,
    );
    const ids = await clauseIdsForSection("rule3");
    expect(ids).toHaveLength(2);
    const tags0 = await db
      .select()
      .from(standardClauseFacets)
      .where(eq(standardClauseFacets.clauseId, ids[0]));
    expect(tags0.map((t) => t.facetId)).toEqual([facetId.get("xd-security")]);
    const none1 = await db
      .select()
      .from(standardClauseFacets)
      .where(and(eq(standardClauseFacets.clauseId, ids[1]), isNull(standardClauseFacets.facetId)));
    expect(none1).toHaveLength(1); // explicit "governs nothing"
  });
});
