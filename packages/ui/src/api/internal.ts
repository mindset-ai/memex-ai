// Internal shared helpers for the per-domain API modules (spec-354 sol-2 split).
// These were private/local helpers inside the former all-domains client.ts.
// `tBase()` is used by nearly every tenant-scoped domain module; `OrgTenant` +
// `orgBillingBase()` are billing-specific but live here so the type can be
// re-exported by the barrel alongside the other moved symbols.
import { BASE_URL, tenantBase } from './http';

// t-18 of doc-15: tenancy-scoped surfaces have moved to
// `/api/<namespace>/<memex>/<resource>`. Helper for the call sites — falls back
// to the flat `BASE_URL` when the browsing context is on the bare/apex domain
// (which means we want the std-5 single-membership inference or an entity-keyed
// UUID lookup).
export function tBase(): string {
  return tenantBase() ?? BASE_URL;
}

// spec-171 t-25 / dec-40 (option A): billing is PER-ORG. The subscription routes
// resolve the org from the MEMEX in the path, so to bill a CHOSEN org we must
// build the tenant base from that org's namespace + one of its memexes — NOT
// from `tBase()`/session.currentMemexId, which defaults to the non-billable
// personal Memex. Callers pass an explicit `OrgTenant`; this builds its prefix.
export interface OrgTenant {
  /** The org namespace slug — first path segment. */
  namespace: string;
  /** A representative memex slug under the org — second path segment. */
  memexSlug: string;
}

/**
 * Resolve the `/api/<ns>/<mx>` prefix for org-billing calls. When an explicit
 * `OrgTenant` is given (the upgrade/billing flows always pass one), build the
 * prefix from it. Otherwise fall back to `tBase()` for legacy in-tenant callers.
 */
export function orgBillingBase(orgTenant?: OrgTenant): string {
  if (orgTenant) return `${BASE_URL}/${orgTenant.namespace}/${orgTenant.memexSlug}`;
  return tBase();
}
