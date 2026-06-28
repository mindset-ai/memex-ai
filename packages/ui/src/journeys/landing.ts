// spec-421 dec-5 / issue-1 — the first-load landing predicate.
//
// Barrie/Ryan (Slack 2026-06-27): once a user has engaged we should land them on
// their Specs board, not the onboarding Home. This is the ONE seam that decides it,
// consumed by the app router (RootRedirect) at first load. It SUPERSEDES spec-312
// dec-1's "every authenticated user lands on /home": spec-312 kept everyone on Home
// because the final onboarding step was developer-only (a non-developer would never
// graduate, so Specs stranded them); spec-421 hid those steps, so graduation is now
// simply "created your first spec" and the original objection no longer holds. The
// eventual home-of-value surface (Christine / spec-315) will revisit this.
//
// Read-only by design: the decision is derived fresh from /api/me/journey-state on
// each load and NEVER persisted (Barrie: "it's milliseconds to assess from the
// database … a quick read-only of the state, not stored"). Persisting it would force
// a reassess-and-re-persist per render — the very clunk this replaces.
import { useEffect, useState } from 'react';
import { fetchJourneyStateApi, type JourneyStateResponse } from '../api/journey';

/**
 * Pure predicate: should this user land on /home, or go straight to the Specs board?
 *
 * "Finished getting started" is keyed on the `hasSpec` milestone — the user has created
 * their first (non-demo) spec. That is the terminal step of the VISIBLE 3-step onboarding
 * (spec-421: About you → Connect MCP → Create your first spec) and Ryan's literal "once
 * someone has engaged" signal. We deliberately do NOT use `isJourneyGraduated`, which
 * requires every milestone of the whole SDD loop (resolve-decision, add-ac, plan-grounded,
 * …) and so would keep nearly everyone — and every non-developer — on Home forever.
 *
 * Returns `true` (→ /home) while the user has no spec yet, `false` (→ Specs) once they do.
 * A `null` state (still loading, or the read failed) returns `true` so we default to the
 * guidance-first Home and never flash Specs at a brand-new user. Pure — no side effects,
 * no persistence — so it is the natural extension seam: a future landing rule (e.g. a
 * new-feature indicator) composes here, returning `true` to keep the user on Home.
 */
export function shouldLandOnHome(state: JourneyStateResponse | null): boolean {
  return !state?.milestones?.hasSpec;
}

/**
 * Router hook: resolve the landing decision from a one-shot, read-only journey-state
 * read. Returns `boolean | null` — `null` while the read is in flight so the router
 * can render nothing (no stale-state flash / redraw). On a failed read it resolves to
 * `shouldLandOnHome(null)` (→ Home) rather than stranding the user on a blank screen.
 * `enabled = false` (e.g. when 'home' is hidden, so no Home-vs-Specs choice is needed)
 * skips the fetch entirely.
 */
export function useShouldLandOnHome(enabled = true): boolean | null {
  const [landOnHome, setLandOnHome] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    // Retry a few times on a failed read before giving up: the journey-state read can
    // race the session/token bootstrap (a transient 401/blip), and a returning engaged
    // user must not be stranded on /home by one early failure. A SUCCESSFUL read (even
    // hasSpec=false) is authoritative and never retried — only errors back off.
    const ATTEMPTS = 4;
    const read = (attempt: number): void => {
      fetchJourneyStateApi()
        .then((s) => {
          if (alive) setLandOnHome(shouldLandOnHome(s));
        })
        .catch(() => {
          if (!alive) return;
          if (attempt < ATTEMPTS) {
            setTimeout(() => read(attempt + 1), 250 * attempt);
          } else {
            // Exhausted retries — fall back to the guidance-first Home, not a blank page.
            setLandOnHome(shouldLandOnHome(null));
          }
        });
    };
    read(1);
    return () => {
      alive = false;
    };
  }, [enabled]);

  return landOnHome;
}
