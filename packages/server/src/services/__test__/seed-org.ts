// Test-only helpers that create an Org and a default Memex inside it.
//
// Before doc-19, createOrgWithOwner / createOrgForUser bundled the default
// Memex in the same transaction. Per dec-1 of doc-19 (Org creation inserts
// 0 Memexes), the services no longer do this — but plenty of existing tests
// still want "an Org with a Memex" in one call. These helpers preserve that
// shape for tests without re-introducing the production shortcut.

import { createOrgForUser, createOrgWithOwner } from "../orgs.js";
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
  const created = await createOrgForUser({
    slug: input.slug,
    name: input.name,
    userId: input.userId,
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
