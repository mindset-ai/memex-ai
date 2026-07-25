// spec-474 dec-6 — first-load Memex readiness client.
//
// The onboarding content seed (default Standards + facets; spec-509 dec-2 removed the
// starter-Spec seed) moved OFF the signup request onto an explicit first-load step, so the
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

// A single in-flight provision request, shared by all concurrent callers. The server's
// per-seed existence checks are not concurrency-safe (two POSTs that both read "nothing
// seeded yet" before either inserts would each seed a set), and the gate's own StrictMode
// mount→cleanup→mount cycle fires the effect twice. Collapsing concurrent calls to ONE
// POST makes the seed exactly-once from a single browser.
let inFlightProvision: Promise<void> | null = null;

/** Idempotently seed the caller's own personal Memex. Safe to call repeatedly and
 *  concurrently — concurrent calls share a single POST. */
export async function provisionPersonalMemex(): Promise<void> {
  if (inFlightProvision) return inFlightProvision;
  inFlightProvision = (async () => {
    try {
      const res = await fetchOnce(`${BASE_URL}/me/provision`, { method: 'POST' });
      if (!res.ok) throw new Error(`POST /me/provision failed: ${res.status}`);
    } finally {
      inFlightProvision = null;
    }
  })();
  return inFlightProvision;
}
