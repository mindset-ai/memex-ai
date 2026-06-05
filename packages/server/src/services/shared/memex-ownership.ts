// Cross-cutting authorisation helpers. Multiple services need to verify
// "this resource belongs to that memex" or "this user is a member of the org owning
// that memex" before mutating. Centralising these means the rule lives in one place.

import { and, eq } from "drizzle-orm";
import { db } from "../../db/connection.js";
import {
  documents,
  memexes,
  namespaces,
  orgMemberships,
} from "../../db/schema.js";
import { ForbiddenError, NotFoundError } from "../../types/errors.js";

// Resolve one memex under the namespace owned by `orgId`. Org-level mutations
// (memberships, org settings, consent acceptance) need a memexId to thread into
// the unified bus key so the Memex switcher and any other per-namespace
// subscriber refetches. Per std-1 every org has a namespace and (by signup
// invariant) at least one memex; returns null only in pathological states.
export async function primaryMemexIdForOrg(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: memexes.id })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(namespaces.ownerOrgId, orgId))
    .limit(1);
  return row?.id ?? null;
}

// Inverse of primaryMemexIdForOrg: resolve the org that owns the memex's
// namespace. Returns null for personal memexes (ns.kind === 'user') and in
// the pathological no-namespace state. Used by b-68 t-5 to fetch Org-scoped
// scaffold additions at projection time from the assess_brief handler.
export async function orgIdForMemex(memexId: string): Promise<string | null> {
  const [row] = await db
    .select({ ownerOrgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(memexes.id, memexId))
    .limit(1);
  return row?.ownerOrgId ?? null;
}

// Returns the document if it belongs to memexId, otherwise throws NotFoundError.
// We return NotFoundError (not ForbiddenError) intentionally — leaking "this doc exists
// but isn't yours" via a 403 enables enumeration attacks.
export async function assertDocBelongsToMemex(
  docId: string,
  memexId: string,
): Promise<{ id: string; memexId: string }> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
    columns: { id: true, memexId: true },
  });
  if (!doc) {
    throw new NotFoundError(`Document ${docId} not found`);
  }
  return doc;
}

// Throws ForbiddenError if userId is not allowed to access memexId. Allowed when:
// - the memex's namespace is owned by the user (personal memex), or
// - the memex's namespace is owned by an org and the user has an active org_membership.
export async function assertUserMember(userId: string, memexId: string): Promise<void> {
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) {
    throw new ForbiddenError("Not a member of this Memex");
  }
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, memex.namespaceId),
  });
  if (!ns) {
    throw new ForbiddenError("Not a member of this Memex");
  }
  if (ns.kind === "user") {
    if (ns.ownerUserId === userId) return;
  } else if (ns.kind === "org" && ns.ownerOrgId) {
    const membership = await db.query.orgMemberships.findFirst({
      where: and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.orgId, ns.ownerOrgId),
      ),
      columns: { id: true, status: true },
    });
    if (membership && membership.status === "active") return;
  }
  throw new ForbiddenError("Not a member of this Memex");
}
