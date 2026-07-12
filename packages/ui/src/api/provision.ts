// spec-474 dec-6 — first-load Memex readiness client.
//
// The onboarding content seed (default Standards + facets + the "Understanding Memex"
// starter Spec) moved OFF the signup request onto an explicit first-load step, so the
// signup response and the verification email are never delayed by seconds of seeding.
// The SPA reads readiness from GET /api/me and, for a brand-new (unprovisioned) Memex,
// drives the seed via POST /api/me/provision behind a "Getting your Memex ready…"
// blocker — that request carries its own server CPU allocation, so the seed completes
// reliably (no empty-Memex regression).

import { BASE_URL, fetchWithRetry, fetchOnce } from './http';

/** Whether the caller's personal Memex has had its onboarding content seeded. */
export async function fetchPersonalMemexProvisioned(): Promise<boolean> {
  const res = await fetchWithRetry(`${BASE_URL}/me`);
  if (!res.ok) throw new Error(`GET /me failed: ${res.status}`);
  const data = (await res.json()) as { personalMemexProvisioned?: boolean };
  // Treat anything but an explicit `false` as ready — never block the app on an
  // ambiguous/older response shape.
  return data.personalMemexProvisioned !== false;
}

/** Idempotently seed the caller's own personal Memex. Safe to call repeatedly. */
export async function provisionPersonalMemex(): Promise<void> {
  const res = await fetchOnce(`${BASE_URL}/me/provision`, { method: 'POST' });
  if (!res.ok) throw new Error(`POST /me/provision failed: ${res.status}`);
}
