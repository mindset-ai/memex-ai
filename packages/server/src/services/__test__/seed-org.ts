// Test-only helpers that create an Org and a default Memex inside it.
//
// Before doc-19, createOrgWithOwner / createOrgForUser bundled the default
// Memex in the same transaction. Per dec-1 of doc-19 (Org creation inserts
// 0 Memexes), the services no longer do this — but plenty of existing tests
// still want "an Org with a Memex" in one call. These helpers preserve that
// shape for tests without re-introducing the production shortcut.

import { createOrgWithOwner } from "../orgs.js";
import { db } from "../../db/connection.js";
import { memexes } from "../../db/schema.js";
import type { Memex, Namespace, Org, OrgMembership } from "../../db/schema.js";

export interface SeededOrg {
  org: Org;
  namespace: Namespace;
  memex: Memex;
  membership: OrgMembership;
}

export async function createOrgWithMemexForUser(input: {
  slug: string;
  name?: string;
  userId: string;
  memexSlug?: string;
  memexName?: string;
}): Promise<SeededOrg> {
  // Seed through the un-gated transactional builder (createOrgWithOwner), NOT the
  // public createOrgForUser surface: a test suite provisions many orgs as the same
  // dev user, and createOrgForUser's std-3 gates (email-verified + 5-orgs/24h rate
  // limit) are user-facing policy, not the thing under test — they'd false-fail the
  // 6th+ seed. createOrgWithOwner skips both while still emitting on the bus [per
  // std-8].
  //
  // createdByUserId is deliberately LEFT NULL: it exists only to attribute the
  // org to the std-3 24h rate-limit window (orgs.ts checkRateLimit). Seeded test
  // fixtures must not consume the dev user's REAL org-creation budget, or a
  // journey that drives the genuine POST /api/orgs surface (e.g. the
  // memex-switcher-reactive reactivity check) would 429 after enough seeds.
  const created = await createOrgWithOwner({
    slug: input.slug,
    name: input.name,
    ownerUserId: input.userId,
  });
  const [memex] = await db
    .insert(memexes)
    .values({
      namespaceId: created.namespace.id,
      slug: input.memexSlug ?? "main",
      name: input.memexName ?? "Main",
    })
    .returning();
  return { ...created, memex };
}

export async function createOrgWithMemexAndOwner(input: {
  slug: string;
  name?: string;
  ownerUserId: string;
  memexSlug?: string;
  memexName?: string;
}): Promise<SeededOrg> {
  const created = await createOrgWithOwner({
    slug: input.slug,
    name: input.name,
    ownerUserId: input.ownerUserId,
  });
  const [memex] = await db
    .insert(memexes)
    .values({
      namespaceId: created.namespace.id,
      slug: input.memexSlug ?? "main",
      name: input.memexName ?? "Main",
    })
    .returning();
  return { ...created, memex };
}
