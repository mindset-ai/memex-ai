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
import { getCachedJourneyState, setCachedJourneyState } from './journeyStateCache';

/**
 * spec-508: is the just-assessed user MCP-connected? Reads the same cached journey
 * state `useShouldLandOnHome` populates. RootRedirect pairs this with the spec-less
 * predicate to keep the featured-demo landing to UNACTIVATED users (0 specs AND no
 * MCP). Kept here (not inline in App.tsx) so the router stays free of the journey-
 * cache plumbing — the spec-507 cleanup guard asserts App.tsx never touches it.
 */
export function isMcpConnectedCached(): boolean {
  return !!getCachedJourneyState()?.milestones.mcpConnected;
}

/**
 * Pure predicate: has this user NOT yet created their first spec?
 *
 * NOTE (spec-461 dec-1): this predicate NO LONGER decides a /home landing — the automatic
 * Home landing was retired, so RootRedirect always lands users on their Specs board. The
 * predicate survives because it still keys two behaviours: the spec-502 value-first
 * landing (a spec-less user goes to the featured demo Memex) and the `graduated`
 * engagement signal on the home.landing_routed telemetry. The name is kept for continuity
 * with spec-421; read it as "spec-less?", not "should land on Home".
 *
 * spec-507: it used to key a third — the spec-444 welcome-video re-show gate. That gate
 * is gone; nothing routes to /welcome any more.
 *
 * "Not engaged yet" is keyed on the `hasSpec` milestone — the user has created their first
 * (non-demo) spec, the terminal step of the VISIBLE 3-step onboarding (spec-421: About you →
 * Connect MCP → Create your first spec). We deliberately do NOT use `isJourneyGraduated`,
 * which requires every milestone of the whole SDD loop and so would treat nearly everyone —
 * and every non-developer — as un-engaged forever.
 *
 * Returns `true` while the user has no spec yet, `false` once they do. A `null` state
 * (still loading, or the read failed) returns `true`, so on a transient read failure a
 * brand-new user is still treated as spec-less (the value-first landing fires) rather
 * than being mistaken for an established user.
 */
export function shouldLandOnHome(state: JourneyStateResponse | null): boolean {
  return !state?.milestones?.hasSpec;
}

/**
 * Router hook: resolve the spec-less signal from a one-shot, read-only journey-state
 * read. Returns `boolean | null` — `null` while the read is in flight so the router can
 * render nothing (no stale-state flash / redraw). On a failed read it resolves to
 * `shouldLandOnHome(null)` (= true) so a new user still gets the value-first landing
 * rather than being skipped past it on a transient blip. Post spec-461 / spec-507 this
 * drives the spec-502 featured-demo landing + engagement telemetry, not a Home landing.
 * `enabled = false` (e.g. when 'home' is hidden) skips the fetch entirely.
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
          // spec-421 issue-2 — share this read-only assessment in-memory so a later in-app
          // navigation to /home paints the tracker from it (before draw) instead of
          // re-assessing from null after mount (the flicker). Not persisted (Barrie).
          setCachedJourneyState(s);
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
