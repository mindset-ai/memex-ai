// spec-303 — journey registry (dec-1/dec-6). v0 ships one journey (onboarding).
// The engine asks the registry which journey applies to a user; adding a journey
// is a new module registered here, never a change to the engine.
import { onboardingJourney } from "./onboarding.js";

export type { JourneyDef, JourneyStepDef, JourneyMilestone } from "./onboarding.js";
export { onboardingJourney } from "./onboarding.js";

import type { JourneyDef } from "./onboarding.js";

export const JOURNEYS: readonly JourneyDef[] = [onboardingJourney];

/** The journey that applies to a user. v0: always onboarding (dec-6). */
export function activeJourney(): JourneyDef {
  return onboardingJourney;
}
