// spec-421 issue-2 — the session-scoped, in-memory journey-state cache.
//
// Barrie's clunkiness fix (Slack 2026-06-27): the journey/onboarding state was "only
// assessed when the page is drawn, so you get the old state first and then a redraw."
// His prescription — assess it BEFORE draw, as a quick read-only that is NOT stored:
// "it's milliseconds to assess from the database based on what the user has done … a
// quick read-only of the state (not stored). … if you persist the state then you will
// get this slow load again as the state has to be reassessed and re-persisted per render."
//
// So this is a plain module variable — in-memory only, gone on a full page reload. It is
// NOT localStorage / sessionStorage / any client store (that is the persistence Barrie
// warned against, and what ac-24 forbids). It simply lets the ONE read-only assessment the
// app already does (the login-time read in useShouldLandOnHome / RootRedirect) be shared,
// so an in-app navigation to /home can paint the tracker at its already-assessed value on
// first render instead of re-assessing from null after draw (the flicker). Every successful
// read refreshes it; the live read on /home still runs and is authoritative.
import type { JourneyStateResponse } from '../api/journey';

let cached: JourneyStateResponse | null = null;

/** The last read-only journey-state assessment this session, or null if none yet. */
export function getCachedJourneyState(): JourneyStateResponse | null {
  return cached;
}

/** Record the latest read-only assessment so the next surface can paint from it. */
export function setCachedJourneyState(state: JourneyStateResponse | null): void {
  cached = state;
}

/** Test-only: clear the in-memory assessment between cases. */
export function resetCachedJourneyState(): void {
  cached = null;
}
