// spec-171 t-25 / ac-39 / dec-40 (option A): billing is PER-ORG (std-1 cl-3).
// A user has a personal Memex (NOT billable) and may administer MULTIPLE orgs
// (std-4, spec-307). The hosted upgrade + billing flows must let the caller
// CHOOSE which org to bill — they must NOT silently bill whatever the session
// happens to be scoped to (which defaults to the non-billable personal Memex).
//
// The subscription routes are mounted ONLY under the tenant prefix
// (/api/<ns>/<mx>/orgs/current/subscription) and resolve the org from the MEMEX
// in the path (resolveOrgIdFromMemex). So to bill a chosen org we build the
// tenant base from THAT org's namespace slug + one representative memex slug.
//
// Everything we need is already on the cached session's `memberships` — each row
// carries `orgId`, `role`, `kind`, namespace `slug`, and `memexSlug`. No new
// server endpoint required: we filter + group client-side. This module is pure
// (no React) so it can be unit-tested in isolation.

import type { MembershipSummary, SessionPayload } from '../../api/client';

/**
 * A billable org the caller administers, with a tenant base resolved to one of
 * the org's memexes. `namespace`/`memexSlug` form the `/api/<ns>/<mx>` prefix the
 * subscription routes are mounted under.
 */
export interface AdminOrg {
  orgId: string;
  /** Org display name (std-1: an "org", never a "team"/"account"). */
  name: string;
  /** Namespace slug — first path segment of the org's tenant URLs. */
  namespace: string;
  /** A representative memex slug under the org — second path segment. */
  memexSlug: string;
}

/**
 * Derive the orgs the caller can be billed for: org-namespace memberships
 * (`kind: 'team'`) where the caller is an administrator and the row is a real
 * membership (not a read-only `'visited'` pin on a public memex). Personal
 * namespaces are excluded — they're never billable.
 *
 * Grouped by `orgId` (an org can expose several memexes; we only need one to
 * address the org), preserving first-seen order. The representative memex is the
 * first membership row seen for that org.
 */
export function deriveAdminOrgs(
  session: SessionPayload | null | undefined,
): AdminOrg[] {
  const memberships = session?.memberships;
  if (!memberships || memberships.length === 0) return [];

  const byOrg = new Map<string, AdminOrg>();
  for (const m of memberships) {
    if (!isBillableAdminMembership(m)) continue;
    const orgId = m.orgId;
    // orgId is required for grouping; skip rows that somehow lack it.
    if (!orgId) continue;
    if (byOrg.has(orgId)) continue; // keep the first representative memex
    byOrg.set(orgId, {
      orgId,
      name: m.name,
      namespace: m.slug,
      memexSlug: m.memexSlug,
    });
  }
  return Array.from(byOrg.values());
}

function isBillableAdminMembership(m: MembershipSummary): boolean {
  if (m.kind !== 'team') return false; // exclude personal namespaces
  if (m.role !== 'administrator') return false; // only admins can bill
  if (m.source === 'visited') return false; // read-only public pin, not a real org membership
  if (!m.memexSlug) return false; // can't build a tenant base without it
  return true;
}
