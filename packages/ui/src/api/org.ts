// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import { MemberApiError } from './errors';
import { BASE_URL, fetchWithRetry, authHeaders } from './http';
import { tBase } from './internal';

export type SubdomainCheckError = 'too_short' | 'too_long' | 'invalid_chars' | 'reserved' | 'taken';

export interface SubdomainCheckResult {
  valid: boolean;
  available: boolean;
  error?: SubdomainCheckError;
}

export async function checkSubdomainApi(
  subdomain: string,
  token: string | null,
): Promise<SubdomainCheckResult> {
  const res = await fetchWithRetry(
    `${BASE_URL}/orgs/check?slug=${encodeURIComponent(subdomain)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`Subdomain check failed: ${res.status}`);
  }
  return res.json();
}

export interface Invite {
  id: string;
  orgId: string;
  token: string;
  revokedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

// Invite mint/list/revoke moved under the tenant prefix (/api/<ns>/<mx>/invites)
// because the handlers need `ctx.currentMemexId`, which memexResolver only sets
// for path-prefixed URLs. `joinOrgApi` below still hits flat /api/invites/accept
// — that route IS the path that grants a tenant context, so it can't require one.

// Optional tenant override. When omitted, the helpers fall back to `tBase()` —
// the caller's current memex (URL path or session). Pass an explicit value to
// target a SPECIFIC org's invite list (e.g. from the Manage Orgs page, where
// the cards may belong to orgs other than the one in the user's session).
// Invites are stored at the org level (`invite_tokens.orgId`), so the memex
// segment just identifies which org via memexResolver — any memex of the
// target org works.
function invitesBase(override?: { namespaceSlug: string; memexSlug: string }): string {
  if (override) return `${BASE_URL}/${override.namespaceSlug}/${override.memexSlug}`;
  return tBase();
}

export async function createInviteApi(
  token: string | null,
  tenantOverride?: { namespaceSlug: string; memexSlug: string },
): Promise<Invite> {
  const res = await fetchWithRetry(`${invitesBase(tenantOverride)}/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Create invite failed: ${res.status}`);
  }
  return res.json();
}

export async function listInvitesApi(
  token: string | null,
  tenantOverride?: { namespaceSlug: string; memexSlug: string },
): Promise<Invite[]> {
  const res = await fetchWithRetry(`${invitesBase(tenantOverride)}/invites`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`List invites failed: ${res.status}`);
  }
  return res.json();
}

export async function revokeInviteApi(
  inviteId: string,
  token: string | null,
  tenantOverride?: { namespaceSlug: string; memexSlug: string },
): Promise<Invite> {
  const res = await fetchWithRetry(`${invitesBase(tenantOverride)}/invites/${inviteId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Revoke invite failed: ${res.status}`);
  }
  return res.json();
}

export interface OrgSummaryDto {
  id: string;
  name: string;
  slug: string;
  emailDomains: string[];
  autoGroupingEnabled: boolean;
  domainVerified: boolean;
  freeDomainsInUse: string[];
  verifiedDomains: Array<{ domain: string; method: 'sso' | 'email'; verifiedAt: string }>;
  billingContactName: string | null;
  billingContactEmail: string | null;
}

// `/orgs/current/*` (settings, members, domain verification) needs a memex
// context, so it lives under the tenant prefix. `BASE_URL` is the fallback for
// callers on the bare domain — in practice every UI page that hits these is
// inside a tenant, so tBase() returns the prefixed URL.

export async function getOrgApi(token: string | null): Promise<OrgSummaryDto> {
  const res = await fetchWithRetry(`${tBase()}/orgs/current`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`Get org failed: ${res.status}`);
  return res.json();
}

export async function updateOrgApi(
  token: string | null,
  patch: {
    name?: string;
    emailDomains?: string[];
    autoGroupingEnabled?: boolean;
    billingContactName?: string | null;
    billingContactEmail?: string | null;
  },
): Promise<OrgSummaryDto> {
  const res = await fetchWithRetry(`${tBase()}/orgs/current`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Update org failed: ${res.status}`);
  }
  return body;
}

export interface DomainVerifyInitResult {
  id: string;
  domain: string;
  expiresAt: string;
  sentTo: string[];
  sendErrors?: string[];
}

export async function initiateDomainVerificationApi(
  token: string | null,
  domain: string,
): Promise<DomainVerifyInitResult> {
  const res = await fetchWithRetry(`${tBase()}/orgs/current/domains/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ domain }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Initiate verification failed: ${res.status}`);
  }
  return body;
}

// ── Org members (admin) ──

export interface OrgMemberDto {
  userId: string;
  email: string;
  role: 'member' | 'administrator';
  status: 'active' | 'disabled';
  joinedAt: string;
}

export async function listOrgMembersApi(token: string | null): Promise<OrgMemberDto[]> {
  const res = await fetchWithRetry(`${tBase()}/orgs/current/members`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`List members failed: ${res.status}`);
  return res.json();
}

export interface MemberPatchInput {
  role?: 'member' | 'administrator';
  status?: 'active' | 'disabled';
}

// Read-only member list available to any active org member (unlike listOrgMembersApi,
// which is admin-only). Returns only ACTIVE members, no status field. Powers the in-header
// Org dialog.
export interface TeamMemberDto {
  userId: string;
  email: string;
  role: 'member' | 'administrator';
  joinedAt: string;
}

export async function listTeamMembersApi(token: string | null): Promise<TeamMemberDto[]> {
  const res = await fetchWithRetry(`${tBase()}/team/members`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `List team members failed: ${res.status}`);
  }
  return res.json();
}

export async function patchOrgMemberApi(
  token: string | null,
  userId: string,
  patch: MemberPatchInput,
): Promise<OrgMemberDto> {
  const res = await fetchWithRetry(`${tBase()}/orgs/current/members/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new MemberApiError(res.status, body.code, body.error ?? `Member update failed: ${res.status}`);
  }
  return body;
}
