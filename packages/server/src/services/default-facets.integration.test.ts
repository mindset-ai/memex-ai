// spec-340 t-2 — per-owner default-facet seeding + the backfill that seeds every
// existing org AND personal memex. DB-backed: the zero-row idempotency guard and the
// (owner_type, owner_id, key) uniqueness are enforced by Postgres.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets, namespaces, memexes } from "../db/schema.js";
import { DEFAULT_FACETS } from "../db/default-facets.fixture.js";
import {
  seedDefaultFacetsForOwner,
  backfillDefaultFacetsAllOwners,
} from "./default-facets.js";
import { makeTestMemex, makePersonalTestMemex } from "./test-helpers.js";
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

async function facetKeysFor(ownerType: "org" | "memex", ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ key: facets.key, name: facets.name, ord: facets.ord })
    .from(facets)
    .where(and(eq(facets.ownerType, ownerType), eq(facets.ownerId, ownerId)));
  return rows.map((r) => r.key);
}

let orgMemexId: string;
let orgId: string;
let personalMemexId: string;

beforeAll(async () => {
  orgMemexId = await makeTestMemex("facseed");
  orgId = await orgIdFor(orgMemexId);
  personalMemexId = await makePersonalTestMemex("facseedp");
});

afterAll(async () => {
  await db.delete(facets).where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId))).catch(() => {});
  await db.delete(facets).where(and(eq(facets.ownerType, "memex"), eq(facets.ownerId, personalMemexId))).catch(() => {});
});

describe("default-facet seeding per owner (spec-340 t-2)", () => {
  it("seeds exactly the 16 defaults with stable key, label, and fixture order (ac-32)", async () => {
    tagAc(AC(32));
    await seedDefaultFacetsForOwner({ ownerType: "org", ownerId: orgId });

    const rows = await db
      .select({ key: facets.key, name: facets.name, ord: facets.ord })
      .from(facets)
      .where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId)))
      .orderBy(facets.ord);

    expect(rows.length).toBe(DEFAULT_FACETS.length); // 16
    expect(rows.map((r) => r.key)).toEqual(DEFAULT_FACETS.map((f) => f.key));
    expect(rows.map((r) => r.name)).toEqual(DEFAULT_FACETS.map((f) => f.name));
    expect(rows.map((r) => r.ord)).toEqual(DEFAULT_FACETS.map((_, i) => i));
    // Every facet carries a non-empty description (the classifier rubric is REQUIRED).
    const descs = await db
      .select({ description: facets.description })
      .from(facets)
      .where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId)));
    expect(descs.every((d) => d.description.length > 0)).toBe(true);
  });

  it("is idempotent — re-running seeds no duplicates, keys/ids unchanged (ac-36)", async () => {
    tagAc(AC(36));
    const before = await db
      .select({ id: facets.id, key: facets.key })
      .from(facets)
      .where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId)));
    // Re-seed twice — the zero-row guard short-circuits, no new rows, ids preserved.
    await seedDefaultFacetsForOwner({ ownerType: "org", ownerId: orgId });
    await seedDefaultFacetsForOwner({ ownerType: "org", ownerId: orgId });
    const after = await db
      .select({ id: facets.id, key: facets.key })
      .from(facets)
      .where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId)));

    expect(after.length).toBe(before.length);
    expect(new Set(after.map((r) => r.id))).toEqual(new Set(before.map((r) => r.id)));
  });
});

describe("backfill seeds every org AND personal memex (spec-340 t-2, ac-31)", () => {
  it("after backfill, both an org owner and a personal memex carry the 16 defaults (ac-31, ac-36)", async () => {
    tagAc(AC(31));
    tagAc(AC(36));

    // Personal memex starts with no vocabulary (makePersonalTestMemex doesn't seed).
    expect(await ownerForMemex(personalMemexId)).toEqual({ ownerType: "memex", ownerId: personalMemexId });
    expect((await facetKeysFor("memex", personalMemexId)).length).toBe(0);

    await backfillDefaultFacetsAllOwners();

    // The org owner carries the 16 (idempotent over the t-2 describe's seed).
    expect(new Set(await facetKeysFor("org", orgId))).toEqual(new Set(DEFAULT_FACETS.map((f) => f.key)));
    // The personal memex now carries its own copy of the 16 — the make-or-break path
    // a naive org-only seed would have missed (dec-7).
    expect(new Set(await facetKeysFor("memex", personalMemexId))).toEqual(
      new Set(DEFAULT_FACETS.map((f) => f.key)),
    );

    // Idempotent: a second backfill leaves counts unchanged.
    await backfillDefaultFacetsAllOwners();
    expect((await facetKeysFor("memex", personalMemexId)).length).toBe(DEFAULT_FACETS.length);
    expect((await facetKeysFor("org", orgId)).length).toBe(DEFAULT_FACETS.length);
  });
});
