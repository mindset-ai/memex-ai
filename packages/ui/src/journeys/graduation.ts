// spec-312 dec-2 — the `graduated` signal seam.
//
// Home shows the journey layer EXPANDED while a user has not graduated their journey,
// and COLLAPSED (to pearls) once they have. The real per-journey graduation predicate
// is owned by the sibling journey-engine spec (spec-313). Until that lands, this is a
// deliberate STUB: a journey is "graduated" when every one of its derived steps is
// attained ("every milestone met").
//
// This is the single seam HomeCanvas consumes — when spec-313 ships its predicate,
// swap the body here and nothing else in the UI changes. It must never decide whether
// the home-of-value content renders (that is always on the page); it only governs the
// journey layer's prominence.
import type { JourneyStateResponse } from '../api/journey';

/** STUB (spec-312): graduated ⇔ every derived step is attained. A state with no steps
 * yet (still loading, or no journey) is treated as not-graduated so the journey layer
 * shows by default. */
export function isJourneyGraduated(state: JourneyStateResponse | null): boolean {
  if (!state?.steps?.length) return false;
  return state.steps.every((s) => s.attained);
}
