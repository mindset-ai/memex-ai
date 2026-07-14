// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import type { NamespaceHomeResponse, MemexDto } from './types';
import { AuthApiError, OrgApiError } from './errors';
import { fetchJson as fetchJsonRaw } from './fetchJson';
import { BASE_URL, fetchWithRetry, fetchOnce, authHeaders } from './http';

export interface MembershipSummary {
  /** The Memex id this membership grants access to. */
  memexId: string;
  /**
   * The owning Org id for team rows; null/absent for personal rows and for
   * sessions cached before this field shipped. Set by the server's
   * `listMemberships`. spec-171 t-25: the upgrade/billing flows group billable
   * admin memberships by this id so the caller can choose WHICH org to bill.
   */
  orgId?: string | null;
  /** Namespace slug — the first path segment in /<namespace>/<memex>/ URLs. */
  slug: string;
  /**
   * Memex slug — the second path segment in /<namespace>/<memex>/ URLs.
   * Added in t-18 of doc-15 so the React UI can construct the path-prefixed
   * API URLs (/api/<slug>/<memexSlug>/docs etc.) without hard-coding the
   * "personal" / "main" convention.
   */
  memexSlug: string;
  /** Org name for team rows; memex name for personal rows. */
  name: string;
  /**
   * Memex's own display name. Always populated; for personal rows it equals
   * `name`, for team rows it's the Memex's own name (so sibling Memexes in
   * the same Org display distinctly).
   */
  memexName?: string;
  kind: 'personal' | 'team';
  /** Role on the Org. Per t-11 the legacy `'user'` value is now `'member'`. */
  role: 'member' | 'administrator';
  /**
   * Access provenance (spec-111 t-6/t-8). `'org'` rows come from a personal
   * namespace or an active org membership — full read+write (std-4). `'visited'`
   * rows come from `user_memex_access` — a signed-in NON-member's pin on a
   * public Memex, read-only. The React UI uses this to render the "Visited"
   * group (🌐 + read-only badge) and to suppress edit/create controls.
   *
   * Optional for back-compat with sessions cached before spec-111 (and test
   * fixtures): absent ⇒ treat as `'org'` (full access). Read-only is opt-IN via
   * an explicit `'visited'`, never inferred from absence.
   */
  source?: 'org' | 'visited';
  /**
   * Effective access level for this row. `'write'` for org rows (std-4
   * members), `'read'` for visited public Memexes. Distinct from `role` (the
   * user's org role, meaningless for non-members). Absent ⇒ treat as `'write'`.
   */
  accessLevel?: 'read' | 'write';
  /**
   * The Memex's own visibility (spec-111 t-8). Rides on the membership row (set
   * by the server's `listMemberships`) so the global header can light the 🌐
   * public badge next to the Memex name without a second fetch. Optional for
   * back-compat with pre-spec-111 sessions / fixtures; absent ⇒ render no badge.
   */
  visibility?: 'public' | 'private';
}

export interface SessionPayload {
  user: {
    id: string;
    email: string;
    name: string | null;
    status: 'active' | 'disabled';
    emailVerified: boolean;
    /** spec-444: ISO timestamp of first permanent welcome-video dismiss; null = not yet dismissed. */
    videoWelcomedAt: string | null;
  };
  memberships: MembershipSummary[];
  /** The Memex the session is currently scoped to. */
  currentMemexId: string | null;
  currentRole: 'member' | 'administrator' | null;
  needsOnboarding: boolean;
  /** Server-driven feature-hide list (slugs the client should suppress). Sourced from
   *  the server's HIDDEN_FEATURES env var; fail-open ([]) when unset. */
  hiddenFeatures: string[];
  /** Fresh session token (present on signup/login/SSO/magic-link responses). Client stores
   *  as `memex-auth-token`. Absent on session refresh responses (client already has it). */
  token?: string;
  /** Present on verify-email and magic-link/consume responses only. True when this was
   *  the first verification (a new account), false/absent for subsequent logins. */
  isNewAccount?: boolean;
  /** The event_id used for server-side conversion API calls on new-account verification.
   *  Client should use this (not a freshly-generated UUID) for the dataLayer push so
   *  both legs share the same ID and ad platforms can deduplicate. Null when attribution
   *  cookie was absent on verification. */
  conversionEventId?: string | null;
  /**
   * Orgs the user is an active member of that have no Memexes yet (doc-19 dec-1).
   * These are invisible in `memberships` (memex-keyed) but must appear in the
   * switcher so the user can navigate to them. Optional for back-compat with
   * sessions cached before this field shipped.
   */
  emptyOrgs?: Array<{
    orgId: string;
    slug: string;
    name: string;
    role: 'member' | 'administrator';
  }>;
}

async function authEndpoint(
  path: string,
  body: Record<string, unknown>,
  token: string | null = null,
): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AuthApiError(
      res.status,
      data.reason ?? data.error,
      data.message ?? data.error ?? `Request failed: ${res.status}`,
    );
  }
  return data;
}

export async function fetchSessionApi(token: string | null): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/me`, {
    headers: { ...authHeaders(token) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AuthApiError(
      res.status,
      body.reason ?? body.error,
      body.message ?? body.error ?? `Session refresh failed: ${res.status}`,
    );
  }
  return res.json();
}

export interface ProbeResult {
  exists: boolean;
  hasPassword: boolean;
}

export async function probeAuthApi(email: string): Promise<ProbeResult> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AuthApiError(
      res.status,
      body.reason ?? body.error,
      body.message ?? body.error ?? `Probe failed: ${res.status}`,
    );
  }
  return res.json();
}

export async function signupApi(email: string, password: string): Promise<SessionPayload> {
  // Retry stays ON here: signup is guarded by the unique-email constraint (a retried
  // POST hits createUserWithPassword's 409 and sends no second email), so retrying is
  // duplicate-safe AND recovers a Cloud Run cold-start 502. Only resend — which has no
  // such guard — must be single-shot (see resendVerificationApi).
  return authEndpoint('/auth/signup', { email, password });
}

export async function loginApi(email: string, password: string): Promise<SessionPayload> {
  return authEndpoint('/auth/login', { email, password });
}

export async function verifyEmailApi(token: string): Promise<SessionPayload> {
  return authEndpoint('/auth/verify-email', { token });
}

export async function resendVerificationApi(token: string | null): Promise<void> {
  // fetchOnce (no retry): this send is non-idempotent — a retried POST on a timeout
  // would deliver a second verification email. The button's own cooldown covers
  // deliberate re-sends.
  const res = await fetchOnce(`${BASE_URL}/auth/resend-verification`, {
    method: 'POST',
    headers: { ...authHeaders(token) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AuthApiError(
      res.status,
      body.reason ?? body.error,
      body.message ?? body.error ?? `Resend failed: ${res.status}`,
      typeof body.retryAfterSec === 'number' ? body.retryAfterSec : undefined,
    );
  }
}

/**
 * spec-304 t-40 (ac-30): the issue response now carries a high-entropy
 * `loginRequestId` (a `login_requests` surrogate row, TTL matching the
 * magic-link token). The originating tab/webview keeps this id and polls
 * `magicLinkStatusApi` so the session can complete IN PLACE once the link is
 * verified in a different browser/context — no click-back required. The id is
 * NOT the raw token; it only names the surrogate to poll. Callers that ignore
 * the return value keep working unchanged.
 */
export async function magicLinkRequestApi(email: string): Promise<{ loginRequestId: string }> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AuthApiError(
      res.status,
      body.reason ?? body.error,
      body.message ?? body.error ?? `Magic link request failed: ${res.status}`,
    );
  }
  return res.json();
}

/**
 * spec-304 t-40 (ac-30): the originating-session poll target. Unauthenticated
 * GET on the surrogate named by `magicLinkRequestApi`'s `loginRequestId`. The
 * server returns one of:
 *   - pending  → `{ verified: false, expired: false }`
 *   - expired  → `{ verified: false, expired: true }`
 *   - verified → `{ verified: true, ...SessionPayload }` (the same payload
 *                `/consume` returns) — SINGLE-SHOT: the row is deleted on first
 *                verified read, so a second poll 404s. Callers MUST stop polling
 *                and hand the session to `acceptSession` in the same tick.
 *   - unknown  → 404 `{ error: 'Unknown login request' }` → throws NotFoundError.
 * Routed through `fetchJson` so 404 maps to `NotFoundError`; the poll loop
 * treats that (and `expired: true`) as a dead surrogate and stops.
 */
export type MagicLinkStatus =
  | { verified: false; expired: boolean }
  | ({ verified: true } & SessionPayload);

export async function magicLinkStatusApi(loginRequestId: string): Promise<MagicLinkStatus> {
  return fetchJsonRaw<MagicLinkStatus>(
    fetchWithRetry,
    `${BASE_URL}/auth/magic-link/login-requests/${encodeURIComponent(loginRequestId)}/status`,
  );
}

export async function magicLinkConsumeApi(token: string): Promise<SessionPayload> {
  return authEndpoint('/auth/magic-link/consume', { token });
}

export async function passwordResetRequestApi(email: string): Promise<void> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/password-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AuthApiError(
      res.status,
      body.reason ?? body.error,
      body.message ?? body.error ?? `Reset request failed: ${res.status}`,
    );
  }
}

export async function passwordResetConfirmApi(
  token: string,
  password: string,
): Promise<SessionPayload> {
  return authEndpoint('/auth/password-reset/confirm', { token, password });
}

export async function ssoLoginApi(idToken: string, memexId?: string): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/sso/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...(memexId ? { memexId } : {}) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `SSO login failed: ${res.status}`);
  }
  return res.json();
}

export async function updateProfileApi(
  token: string | null,
  name: string,
  // spec-305 dec-5: the optional developer/designer/PM triangle (barycentric weights).
  roleCoords?: { dev: number; design: number; pm: number },
): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/profile`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ name, ...(roleCoords ? { roleCoords } : {}) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Profile update failed: ${res.status}`);
  }
  return res.json();
}

// spec-444: permanently dismiss the welcome video — stamps video_welcomed_at on
// the users row. Returns the fresh session so the caller can call updateSession()
// before navigating, preventing a same-session gate re-trigger.
export async function dismissWelcomeVideoApi(token: string | null): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}/welcome-video`, {
    method: 'PATCH',
    headers: { ...authHeaders(token) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Welcome video dismiss failed: ${res.status}`);
  }
  return res.json();
}

// ── Org / Memex creation (doc-15 t-14, doc-19 t-7) ──
// POST /api/orgs creates an Org + its Namespace + an admin membership. Per dec-1
// of doc-19, Org creation no longer bundles a default Memex; the caller adds
// Memexes via the separate /api/namespaces/:id/memexes flow.

export interface OrgCreateResponse {
  org: { id: string; namespaceId: string; name: string };
  namespace: { id: string; slug: string; kind: 'user' | 'org' };
}

export type OrgSlugCheckReason =
  | 'too_short'
  | 'too_long'
  | 'invalid_chars'
  | 'reserved'
  | 'taken'
  | 'redirected';

export interface OrgSlugCheckResult {
  available: boolean;
  reason?: OrgSlugCheckReason;
}

/**
 * Live availability check for the Org-creation form. Calls GET
 * /api/namespaces/check?slug=… which validates format + checks the namespaces
 * table (and the post-rename reservation table).
 */
export async function checkNamespaceSlugApi(
  slug: string,
  token: string | null,
): Promise<OrgSlugCheckResult> {
  const res = await fetchWithRetry(
    `${BASE_URL}/namespaces/check?slug=${encodeURIComponent(slug)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`Slug check failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Create an Org. Returns the new org/namespace pair. The caller is responsible
 * for navigating to the new Org page (no Memex is created — per dec-1 of doc-19).
 *
 * Errors:
 *   - 403 / `email_not_verified` → user must verify email first
 *   - 409 / `slug_taken` → namespace slug already in use
 *   - 429 / `rate_limit_exceeded` → too many orgs created recently
 *   - 400 / `validation_error` → bad slug / name
 */
export async function createOrgApi(
  slug: string,
  token: string | null,
  name?: string,
): Promise<OrgCreateResponse> {
  const res = await fetchWithRetry(`${BASE_URL}/orgs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ slug, ...(name ? { name } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OrgApiError(
      res.status,
      body.code,
      body.code,
      body.error ?? body.message ?? `Create Org failed: ${res.status}`,
    );
  }
  return body;
}

/**
 * Rename a Namespace's slug (PATCH /api/namespaces/:id/slug). Cooldown-protected
 * on the server — surfaces as 429 / `cooldown_active` when blocked.
 */
export async function renameNamespaceSlugApi(
  namespaceId: string,
  newSlug: string,
  token: string | null,
): Promise<{ namespace: { id: string; slug: string } }> {
  const res = await fetchWithRetry(`${BASE_URL}/namespaces/${namespaceId}/slug`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ slug: newSlug }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OrgApiError(
      res.status,
      body.code,
      body.code,
      body.error ?? body.message ?? `Slug rename failed: ${res.status}`,
    );
  }
  return body;
}

/**
 * Fetch the kind-aware home payload for a namespace. The response shape
 * discriminates on `kind`: 'org' has memexes + member count + role; 'personal'
 * has the single personal memex.
 *
 * Errors:
 *   - 403 → caller is not a member / owner of the namespace
 *   - 404 → namespace not found
 */
export async function getNamespaceHomeApi(
  namespaceId: string,
  token: string | null,
): Promise<NamespaceHomeResponse> {
  const res = await fetchWithRetry(`${BASE_URL}/namespaces/${namespaceId}/home`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Namespace home fetch failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Create a sibling Memex inside an existing namespace. Caller must be an active
 * org member; personal namespaces reject with 403 / `kind_not_org` per dec-3 of
 * doc-19.
 *
 * Errors:
 *   - 403 / `kind_not_org` → namespace is a user namespace (Q4-deferred)
 *   - 403 / `not_a_member` → caller is not an active org member
 *   - 409 / `slug_taken` → slug collides within this namespace
 *   - 400 / `validation_error` → bad slug format
 */
export async function createMemexApi(
  namespaceId: string,
  slug: string,
  name: string | undefined,
  token: string | null,
): Promise<{ memex: MemexDto }> {
  const res = await fetchWithRetry(`${BASE_URL}/namespaces/${namespaceId}/memexes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ slug, ...(name ? { name } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OrgApiError(
      res.status,
      body.code,
      body.code,
      body.error ?? body.message ?? `Create Memex failed: ${res.status}`,
    );
  }
  return body;
}

/**
 * Per-namespace slug availability for the Add Memex form. Returns the same
 * shape as checkNamespaceSlugApi.
 */
export async function checkMemexSlugApi(
  namespaceId: string,
  slug: string,
  token: string | null,
): Promise<OrgSlugCheckResult> {
  const res = await fetchWithRetry(
    `${BASE_URL}/namespaces/${namespaceId}/memexes/check?slug=${encodeURIComponent(slug)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`Memex slug check failed: ${res.status}`);
  }
  return res.json();
}

export interface NamespaceGroup {
  /** Namespace UUID — used by /api/namespaces/:namespaceId/* endpoints. */
  namespaceId?: string;
  namespaceSlug: string;
  kind: 'personal' | 'team';
  /** Caller's role in this namespace (administrator for personal). */
  role?: 'member' | 'administrator';
  memexes: { memexId: string; memexSlug?: string; name: string; role: 'member' | 'administrator' }[];
}

/**
 * Fetch the caller's namespaces grouped for the post-login picker. Used when the
 * session has no current Memex (e.g. user belongs to multiple orgs and we need
 * them to pick) and by an in-app namespace switcher built on top of /api/me.
 */
export async function listMyNamespacesApi(token: string | null): Promise<NamespaceGroup[]> {
  const res = await fetchWithRetry(`${BASE_URL}/me/namespaces`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`List namespaces failed: ${res.status}`);
  }
  const body = (await res.json()) as { namespaces: NamespaceGroup[] };
  return body.namespaces;
}

export interface MeSummary {
  user: { id: string; email: string; name: string | null; namespaceId: string | null };
  currentMemexId: string | null;
  currentRole: 'member' | 'administrator' | null;
}

/**
 * Minimal session shape — fast path for SPAs that only need the caller's identity
 * + current memex without the full membership list.
 */
export async function getMeApi(token: string | null): Promise<MeSummary> {
  const res = await fetchWithRetry(`${BASE_URL}/me`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Get me failed: ${res.status}`);
  }
  return res.json();
}

export interface PendingConsentOrg {
  orgId: string;
  name: string;
  slug: string;
  domain: string;
}

export interface PendingConsentResult {
  pending: PendingConsentOrg[];
  disabled: PendingConsentOrg[];
}

export type ConsentResponse = 'accepted' | 'declined' | 'skipped';

export interface ConsentDecisionInput {
  orgId: string;
  response: ConsentResponse;
}

/**
 * Fetch pending domain-match consent prompts for the current user. Returns
 * `pending` (orgs to render in the consent dialog) and `disabled` (orgs where
 * the user has a disabled membership — UI shows a "contact admin" notice).
 * Both lists are server-filtered for stickiness; UI just renders.
 */
export async function getPendingConsentApi(
  token: string | null,
): Promise<PendingConsentResult> {
  const res = await fetchWithRetry(`${BASE_URL}/consent/pending`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch pending consent: ${res.status}`);
  }
  return res.json();
}

/**
 * Submit a batch of consent decisions in one round-trip. Each decision is
 * idempotent server-side, so retrying after a partial network failure is safe.
 * The server applies them in a single transaction and returns `{ ok: true }`.
 */
export async function submitConsentDecisionsApi(
  decisions: ConsentDecisionInput[],
  token: string | null,
): Promise<void> {
  const res = await fetchWithRetry(`${BASE_URL}/consent/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ decisions }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Consent submission failed: ${res.status}`);
  }
}

// ── Org membership (invite accept) ──
// Per doc-15 the new POST /api/orgs surface (createOrgApi above) is the only
// org-creation path live in the React UI. The earlier back-compat shims
// (createAccountApi / listDiscoverableAccountsApi / joinAccountByDomainApi /
// DiscoverableAccount) had no callers post-t-17 and were removed in the
// std-1 drift sweep.

export async function joinOrgApi(
  token: string | null,
  inviteToken?: string,
): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}/invites/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(inviteToken ? { token: inviteToken } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OrgApiError(
      res.status,
      body.error,
      body.reason,
      body.message ?? body.error ?? `Join failed: ${res.status}`,
    );
  }
  return body;
}
