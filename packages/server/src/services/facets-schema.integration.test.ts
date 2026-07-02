// spec-340 t-1 — schema shape for the facet substrate (facets with a polymorphic
// owner, clause→facet tags with the tri-state). DB-backed: the constraints
// (per-owner uniqueness, the owner_type CHECK, the clause-tag tri-state) are
// enforced by Postgres, so a pure unit test on the Drizzle objects could pass while
// the migration is wrong. Each `it` tags the implementation/scope AC it proves.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  facets,
  standardClauseFacets,
  namespaces,
  memexes,
  documents,
  docSections,
  standardClauses,
  users,
} from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { ownerForMemex } from "./shared/memex-ownership.js";

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

// Create a PERSONAL memex (namespace kind='user', no owning org) so the
// owner_type='memex' branch of dec-7 can be exercised directly.
async function makePersonalMemex(prefix: string): Promise<string> {
  const slug = `${prefix}-${Math.abs(hashCode(prefix + Date.now().toString()))}`;
  return db.transaction(async (tx) => {
    // owner_type='user' namespaces MUST carry owner_user_id (owner-XOR invariant).
    const [user] = await tx
      .insert(users)
      .values({ email: `${slug}@example.com` } as typeof users.$inferInsert)
      .returning();
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "user", ownerUserId: user.id })
      .returning();
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Personal" })
      .returning();
    return memex.id;
  });
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

let orgMemexId: string;
let orgId: string;
let orgId2: string;
let personalMemexId: string;
let docId: string;
const clauseIds: string[] = [];

beforeAll(async () => {
  orgMemexId = await makeTestMemex("facsch");
  orgId = await orgIdFor(orgMemexId);
  // A second org to prove facet keys are unique PER OWNER, not globally.
  orgId2 = await orgIdFor(await makeTestMemex("facsch2"));
  personalMemexId = await makePersonalMemex("facschp");

  // A standard doc + section + three clauses to hang clause→facet tags on.
  const [doc] = await db
    .insert(documents)
    .values({ memexId: orgMemexId, handle: "std-facsch", title: "Facet schema test standard", docType: "standard", status: "approved" })
    .returning();
  docId = doc.id;
  const [section] = await db
    .insert(docSections)
    .values({ docId, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  for (let i = 0; i < 3; i++) {
    const [cl] = await db
      .insert(standardClauses)
      .values({ memexId: orgMemexId, docId, sectionId: section.id, seq: i + 1, position: i + 1, body: `clause ${i}` })
      .returning();
    clauseIds.push(cl.id);
  }
});

afterAll(async () => {
  await db.delete(standardClauseFacets).where(eq(standardClauseFacets.memexId, orgMemexId)).catch(() => {});
  await db.delete(facets).where(and(eq(facets.ownerType, "org"), inArray(facets.ownerId, [orgId, orgId2]))).catch(() => {});
  await db.delete(facets).where(and(eq(facets.ownerType, "memex"), eq(facets.ownerId, personalMemexId))).catch(() => {});
  if (docId) await db.delete(documents).where(eq(documents.id, docId)).catch(() => {});
});

describe("facets vocabulary table — polymorphic owner (spec-340 t-1, dec-7)", () => {
  it("has owner_type/owner_id and NO org_id column — no query assumes a non-null org_id (ac-35)", async () => {
    tagAc(AC(35));
    const cols = await db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'facets'`,
    );
    const names = new Set((cols as unknown as { column_name: string }[]).map((r) => r.column_name));
    expect(names.has("owner_type")).toBe(true);
    expect(names.has("owner_id")).toBe(true);
    expect(names.has("org_id")).toBe(false);
  });

  it("is owner-scoped with per-owner (not global) key uniqueness on (owner_type, owner_id, key) (ac-35, ac-32)", async () => {
    tagAc(AC(35));
    tagAc(AC(32));
    // A key that is NOT one of the seeded defaults, so it can't collide with another
    // file's seedDefaultFacets rows in a shared worker DB clone.
    const KEY = "xowner-shared-key";
    // Same key under two different org owners — both must succeed (no global unique).
    await db.insert(facets).values({ ownerType: "org", ownerId: orgId, key: KEY, description: "authz/tenancy/secrets" });
    await db.insert(facets).values({ ownerType: "org", ownerId: orgId2, key: KEY, description: "authz/tenancy/secrets" });
    // …and a personal-memex owner may ALSO hold the same key (dec-7: personal memex owns directly).
    await db.insert(facets).values({ ownerType: "memex", ownerId: personalMemexId, key: KEY, description: "authz" });

    const rows = await db
      .select()
      .from(facets)
      .where(and(eq(facets.key, KEY), inArray(facets.ownerId, [orgId, orgId2, personalMemexId])));
    expect(rows.length).toBe(3);
    expect(new Set(rows.map((r) => `${r.ownerType}:${r.ownerId}`))).toEqual(
      new Set([`org:${orgId}`, `org:${orgId2}`, `memex:${personalMemexId}`]),
    );

    // Duplicate (owner_type, owner_id, key) — must violate facets_owner_key_unique.
    await expect(
      db.insert(facets).values({ ownerType: "org", ownerId: orgId, key: KEY, description: "dup" }),
    ).rejects.toThrow();
  });

  it("rejects an owner_type outside {org, memex} (facets_owner_type_valid CHECK) (ac-35)", async () => {
    tagAc(AC(35));
    await expect(
      db.insert(facets).values({ ownerType: "wat", ownerId: orgId, key: "bad-owner-type", description: "x" }),
    ).rejects.toThrow();
  });

  it("resolves a personal memex to owner_type='memex'/owner_id=memexId (dec-7 owner rule) (ac-35)", async () => {
    tagAc(AC(35));
    const owner = await ownerForMemex(personalMemexId);
    expect(owner).toEqual({ ownerType: "memex", ownerId: personalMemexId });
    const orgOwner = await ownerForMemex(orgMemexId);
    expect(orgOwner).toEqual({ ownerType: "org", ownerId: orgId });
  });
});

describe("clause→facet tags — the tri-state (spec-340 t-1, dec-2/dec-8)", () => {
  it("distinguishes governs-facet, explicit-none, and not-yet-classified (ac-33)", async () => {
    tagAc(AC(33));
    const [secFacet] = await db
      .insert(facets)
      .values({ ownerType: "org", ownerId: orgId, key: "sec-tag", description: "x" })
      .returning();

    // clause[0] governs a facet (member row).
    await db.insert(standardClauseFacets).values({ memexId: orgMemexId, clauseId: clauseIds[0], facetId: secFacet.id });
    // clause[1] is explicitly classified as governing nothing (facet_id NULL).
    await db.insert(standardClauseFacets).values({ memexId: orgMemexId, clauseId: clauseIds[1], facetId: null });
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

  it("enforces at-most-one none-marker and at-most-one membership per (clause,facet) (ac-33)", async () => {
    tagAc(AC(33));
    const [f] = await db.insert(facets).values({ ownerType: "org", ownerId: orgId, key: "dup-tag", description: "x" }).returning();
    await db.insert(standardClauseFacets).values({ memexId: orgMemexId, clauseId: clauseIds[0], facetId: f.id });
    // duplicate membership → partial unique violation
    await expect(
      db.insert(standardClauseFacets).values({ memexId: orgMemexId, clauseId: clauseIds[0], facetId: f.id }),
    ).rejects.toThrow();
    // second none-marker on clause[1] (already has one) → partial unique violation
    await expect(
      db.insert(standardClauseFacets).values({ memexId: orgMemexId, clauseId: clauseIds[1], facetId: null }),
    ).rejects.toThrow();
  });
});
