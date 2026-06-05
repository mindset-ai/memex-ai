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

const API_URL = process.env.E2E_API_URL ?? "http://localhost:8090";

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
