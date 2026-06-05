// spec-111 t-8 — derive the caller's effective access to the Memex named by the
// current URL tenant.
//
// The model (spec-111 §3):
//   - Org members (std-4) get a `source: 'org'`, `accessLevel: 'write'` row for
//     every Memex in their org → full read + write.
//   - A signed-in NON-member who visits a PUBLIC Memex gets a
//     `source: 'visited'`, `accessLevel: 'read'` row (from `user_memex_access`,
//     surfaced by `listMemberships`, t-6) → read-only.
//   - An ANONYMOUS visitor has no session at all → read-only, signed-out.
//
// This hook is the single place the React UI answers "can this caller write?".
// Edit/create controls gate on `canWrite`; the read-only sidebar badge shows
// when a signed-in caller is read-only (`isReadOnly && isAuthenticated`).
//
// Access is resolved from the membership row that matches the current
// `/<namespace>/<memex>` URL. We deliberately do NOT fall back to "any
// membership" — write access is per-Memex, and a user may be a full member of
// Memex A while only a read-only visitor of Memex B.

import { useMemo } from 'react';
import { useAuth } from '../components/AuthContext';
import {
  parseTenantFromPathname,
  type CurrentTenant,
} from '../utils/tenantUrl';
import type { MembershipSummary } from '../api/client';

export interface MemexAccess {
  /** True when a session token is present (vs an anonymous visitor). */
  isAuthenticated: boolean;
  /** The membership row matching the current tenant URL, if any. */
  membership: MembershipSummary | null;
  /**
   * Effective write access to the current Memex. True only for org members of
   * the resolved Memex. A read-only `visited` row or an absent membership
   * (anonymous, or a public Memex the user hasn't pinned yet) → false.
   */
  canWrite: boolean;
  /** Convenience inverse of `canWrite`. */
  isReadOnly: boolean;
  /**
   * True when the current tenant resolves to a `source: 'visited'` row — a
   * signed-in non-member browsing a public Memex they've pinned. Drives the
   * read-only sidebar badge and the "Visited" grouping in the switcher.
   */
  isVisitedReadOnly: boolean;
}

// An explicit membership row grants write ONLY when its accessLevel is 'write'
// (or absent, for back-compat with pre-spec-111 sessions — see client.ts). A
// `visited` row is always read-only.
function membershipGrantsWrite(m: MembershipSummary | null | undefined): boolean {
  if (!m) return false;
  if (m.source === 'visited') return false;
  return m.accessLevel === undefined || m.accessLevel === 'write';
}

// Pure resolver — exported so it can be unit-tested without rendering. Picks the
// membership row matching the tenant (namespace + memex slug), tolerating the
// legacy `memexSlug`-absent / 'main' default the rest of the UI assumes.
export function resolveMemexAccess(
  tenant: CurrentTenant | null,
  memberships: MembershipSummary[] | undefined,
  isAuthenticated: boolean,
): MemexAccess {
  const rows = memberships ?? [];
  const membership = tenant
    ? rows.find(
        (m) =>
          m.slug === tenant.namespace &&
          (m.memexSlug === tenant.memex || (!m.memexSlug && tenant.memex === 'main')),
      ) ?? null
    : null;

  const canWrite = membershipGrantsWrite(membership);
  const isVisitedReadOnly = membership?.source === 'visited';

  return {
    isAuthenticated,
    membership,
    canWrite,
    isReadOnly: !canWrite,
    isVisitedReadOnly,
  };
}

/**
 * Resolve the caller's access to the Memex in the current URL.
 *
 * `pathname` defaults to the live `window.location.pathname` but can be passed
 * explicitly (e.g. from `useLocation()`) so the value re-derives on client-side
 * navigation without a full reload.
 */
export function useMemexAccess(pathname?: string): MemexAccess {
  const { session, isAuthenticated } = useAuth();
  const path =
    pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
  const tenant = parseTenantFromPathname(path);
  return useMemo(
    () => resolveMemexAccess(tenant, session?.memberships, isAuthenticated),
    [tenant?.namespace, tenant?.memex, session?.memberships, isAuthenticated],
  );
}
