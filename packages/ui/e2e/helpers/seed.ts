// E2E seed helpers — thin HTTP clients of the server's test-only router
// (packages/server/src/routes/__test__.ts, mounted at /api/__test__ only when
// MEMEX_ANTHROPIC_FAKE=1). Per spec-172 dec-2 the e2e package no longer touches
// Postgres directly: every seed / read / cleanup goes through the server's real
// services, so seeded mutations emit on the unified bus [per std-8] and schema
// drift breaks the SERVER build loudly instead of rotting silently here.
//
// Base URL: the server origin. We hit the API directly (default 8090, matching
// the anthropic-fake helper) rather than via the Vite proxy, so seeding is
// independent of the browser page and any /api proxy rewrites.

// Default tracks E2E_SERVER_PORT so a port override moves the helpers with the
// server (overriding one without the other sent every request to a dead port).
const API_URL =
  process.env.E2E_API_URL ??
  `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;

async function call<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${API_URL}/api/__test__${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`__test__ ${method} ${path} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

export interface PersonalMemex {
  memexId: string;
  namespaceSlug: string;
  memexSlug: string;
}

/**
 * Resolve a user's personal memex by email → the slugs the path-based URL
 * helpers build `/<ns>/<mx>/...` from, plus the memex id for seeding. Returns
 * null when the user (or its namespace/memex) doesn't exist yet — callers that
 * race the dev-user bootstrap poll until it appears.
 */
export async function getPersonalMemexByEmail(
  email: string
): Promise<PersonalMemex | null> {
  const { memex } = await call<{ memex: PersonalMemex | null }>(
    "GET",
    `/personal-memex?email=${encodeURIComponent(email)}`
  );
  return memex;
}

/** Upsert a user and lazily provision its personal namespace + memex. */
export async function ensureUser(email: string): Promise<string> {
  const { userId } = await call<{ userId: string }>("POST", "/ensure-user", {
    email,
  });
  return userId;
}

/**
 * Set a user's display name so the app skips the onboarding profile screen and
 * routes straight to the tenant. The server's dev-user bypass creates
 * dev@memex.ai WITHOUT a name (→ Onboarding), so journeys (and globalSetup) call
 * this to land on the Specs board.
 */
export async function setUserName(email: string, name: string): Promise<void> {
  await call("POST", "/user-name", { email, name });
}

/**
 * Clear a user's display name — the onboarding journey's precondition (it then
 * walks the profile-setup screen). The per-test fixture re-sets the name
 * afterwards so a cleared name can't leak into later journeys.
 */
export async function clearUserName(email: string): Promise<void> {
  await call("POST", "/user-name", { email, name: null });
}

/**
 * Seed a Spec into a memex through the server's createDocDraft service — so the
 * bus emits `document created` and the SSE-reactive UI sees it like a real Spec.
 * The service mints the handle; we return both the docId (cleanup) and the
 * handle (the canonical `/<ns>/<mx>/specs/<handle>` path the journey navigates).
 */
export async function seedSpecInMemex(opts: {
  memexId: string;
  title: string;
  purpose?: string;
  createdByUserId?: string;
}): Promise<{ docId: string; handle: string }> {
  return call<{ docId: string; handle: string }>("POST", "/seed-spec", opts);
}

/** Hard-delete a seeded doc by id (cascades to its sections). */
export async function deleteDoc(docId: string): Promise<void> {
  await call("DELETE", `/doc/${docId}`);
}

/** Drop every org membership for a user — resets team state between journeys. */
export async function clearOrgMemberships(email: string): Promise<void> {
  await call("POST", "/clear-org-memberships", { email });
}

/**
 * Tear down test-created namespaces (and everything under them) and/or loose
 * docs. Best-effort cleanup driven by the per-test resource tracker.
 */
export async function cleanup(opts: {
  namespaceSlugs?: string[];
  docIds?: string[];
}): Promise<void> {
  await call("POST", "/cleanup", opts);
}

// ── tenancy seed clients (spec-172 t-6 / ac-5) ───────────────────────────────
// Thin HTTP wrappers over the test-only tenancy endpoints. Used by the tenancy
// journeys to provision orgs, memberships, invite/verification tokens and
// verified domains without raw SQL or Postmark.

/**
 * Mark a user's email verified — the precondition the real CreateOrgForm gates
 * on (session.user.emailVerified) and createOrgForUser enforces. The org-creation
 * journey calls this on the dev user before driving the form.
 */
export async function markEmailVerified(email: string): Promise<void> {
  await call("POST", "/mark-email-verified", { email });
}

export interface SeededOrg {
  orgId: string;
  namespaceSlug: string;
  memexSlug: string;
  memexId: string;
}

/**
 * Seed an Org + default Memex with `ownerEmail` as administrator. The journey
 * navigates the returned `/<namespaceSlug>/<memexSlug>/...` paths. Track
 * `namespaceSlug` with `resources.slug(...)` so afterEach tears it down.
 */
export async function seedOrg(opts: {
  ownerEmail: string;
  slug: string;
  name?: string;
  memexSlug?: string;
  memexName?: string;
}): Promise<SeededOrg> {
  return call<SeededOrg>("POST", "/seed-org", opts);
}

/** Add a member (default active member) to a seeded org. */
export async function addOrgMember(opts: {
  orgId: string;
  email: string;
  role?: "member" | "administrator";
  status?: "active" | "disabled";
}): Promise<{ userId: string }> {
  return call<{ ok: boolean; userId: string }>("POST", "/org-add-member", opts);
}

/** Add a claimed (unverified) email domain to a seeded org. */
export async function addOrgDomain(opts: {
  orgId: string;
  domain: string;
}): Promise<void> {
  await call("POST", "/org-add-domain", opts);
}

/** Mint an invite token for an org — the stand-in for the copied invite URL. */
export async function createInvite(orgId: string): Promise<{ token: string; inviteId: string }> {
  return call<{ token: string; inviteId: string }>("POST", "/create-invite", {
    orgId,
  });
}

/**
 * Mint a domain-verification token for an org's claimed domain — the stand-in
 * for the postmaster@ email (Postmark is never hit). The journey navigates
 * `/verify-domain/:token`.
 */
export async function createDomainVerification(opts: {
  orgId: string;
  domain: string;
}): Promise<{ token: string }> {
  return call<{ token: string }>("POST", "/create-domain-verification", opts);
}

/** Directly verify a domain for an org (no email round-trip) — the winning side of a conflict. */
export async function verifyDomain(opts: {
  orgId: string;
  domain: string;
}): Promise<void> {
  await call("POST", "/verify-domain", opts);
}

// ── lifecycle-spine seed clients (spec-172 t-7 / ac-13) ──────────────────────

/**
 * Resolve a memex id from its (namespaceSlug, memexSlug) pair. The lifecycle-
 * spine journey creates its org + memex through the real UI (which hands back
 * only slugs), but seedSpecInMemex / seedOpenDecision are keyed by memexId —
 * this bridges the two. Returns null until the memex exists (poll if racing the
 * UI create's bus round-trip).
 */
export async function resolveMemexId(
  namespaceSlug: string,
  memexSlug: string
): Promise<string | null> {
  const { memexId } = await call<{ memexId: string | null }>(
    "GET",
    `/resolve-memex?namespaceSlug=${encodeURIComponent(
      namespaceSlug
    )}&memexSlug=${encodeURIComponent(memexSlug)}`
  );
  return memexId;
}

/**
 * Seed an OPEN decision (with structured options) onto a doc through the real
 * createDecision service — so the bus emits `decision created` and the
 * SSE-reactive DecisionPanel renders it like any open decision. The lifecycle-
 * spine journey drives the *resolve* half through the real UI; the
 * *candidate→approve* half is already covered by retained journey-14, so we seed
 * an already-open decision rather than re-walking candidate approval.
 */
export async function seedOpenDecision(opts: {
  memexId: string;
  docId: string;
  title: string;
  context?: string;
  options: { label: string; trade_offs?: string }[];
}): Promise<{ decisionId: string; seq: number }> {
  return call<{ decisionId: string; seq: number }>(
    "POST",
    "/seed-open-decision",
    opts
  );
}

/**
 * Real native-auth signup [per std-13] that returns the raw email-verification
 * token. The production signup handler emails the raw token and auth_tokens
 * persists only its sha256 hash, so the raw value can only be recovered through
 * this seam — Postmark is never contacted.
 *
 * The browser CAN then authenticate as the signed-up user: since the spec-172
 * issue-1 fix, session.ts#resolveBearerUser honours a presented valid session
 * JWT even in dev mode (the dev@memex.ai bypass applies only to token-less
 * requests). See the lifecycle-spine journey's signup leg.
 */
export async function signupWithToken(opts: {
  email: string;
  password: string;
}): Promise<{ userId: string; verificationToken: string }> {
  return call<{ userId: string; verificationToken: string }>(
    "POST",
    "/signup-with-token",
    opts
  );
}

// ── spec-188: verify-phase journey seeds ────────────────────────────────────

/** Seed an AC on a Spec; returns the canonical acUid for test-event seeding. */
export async function seedAc(opts: {
  memexId: string;
  docId: string;
  kind?: "scope" | "implementation";
  statement: string;
}): Promise<{ acId: string; seq: number; acUid: string | null }> {
  return call("POST", "/seed-ac", opts);
}

/** Seed an Issue (bug/todo) on a Spec, optionally already resolved/won't-fix. */
export async function seedIssue(opts: {
  memexId: string;
  docId: string;
  type?: "bug" | "todo";
  title: string;
  body?: string;
  status?: "open" | "resolved" | "wont_fix";
}): Promise<{ issueId: string; seq: number }> {
  return call("POST", "/seed-issue", opts);
}

/** Seed a test-event emission for an acUid (insert + latest-summary upsert),
 *  bypassing the emission-key gate — drives the spec-188 acceptance-precedence
 *  path (a failing event suppresses a manual acceptance). */
export async function seedTestEvent(opts: {
  acUid: string;
  status: "pass" | "fail" | "error";
  testIdentifier?: string;
}): Promise<void> {
  await call("POST", "/seed-test-event", opts);
}

// ── spec-199 t-9: security journey seeds ────────────────────────────────────

/** Seed an assignee on a Spec through the real assign service. */
export async function seedAssignee(opts: {
  memexId: string;
  docId: string;
  userId: string;
}): Promise<{ assigneeId: string }> {
  return call("POST", "/seed-assignee", opts);
}

/** Flip a Memex's visibility to public or private. */
export async function setMemexVisibility(opts: {
  memexId: string;
  visibility: "public" | "private";
}): Promise<void> {
  await call("POST", "/set-memex-visibility", opts);
}

/** Disable an org member and bulk-revoke their share tokens via the real
 *  disableMembership service. Caller must ensure a second admin exists in the
 *  org first (so the last-admin guard passes). */
export async function disableMember(opts: {
  orgId: string;
  targetUserId: string;
}): Promise<void> {
  await call("POST", "/disable-member", opts);
}

/** Seed a raw activity_log row with optional sensitive fields. */
export async function seedActivityRow(opts: {
  memexId: string;
  actorUserId?: string | null;
  clientId?: string;
  payload?: unknown;
  narrative?: string;
}): Promise<{ activityId: string }> {
  return call("POST", "/seed-activity", opts);
}

/** Seed a Task on a Spec (spec-188: drives the Build-tab completion Metric
 *  and the Verify-tab task echo). */
export async function seedTask(opts: {
  memexId: string;
  docId: string;
  title: string;
  description?: string;
  status?: "not_started" | "in_progress" | "complete";
}): Promise<{ taskId: string; seq: number }> {
  return call("POST", "/seed-task", opts);
}
