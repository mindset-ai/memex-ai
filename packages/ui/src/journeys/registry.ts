// spec-303 — the journey registry (dec-1/dec-6). The Home Canvas engine resolves
// journeys and step views from here; adding a journey is a new module registered
// in this map, never a change to the engine. v0 ships a single journey.
import type { JourneyModule, JourneyStepView } from './types';
import { onboardingJourney } from './onboarding';

export const JOURNEY_MODULES: Record<string, JourneyModule> = {
  onboarding: onboardingJourney,
};

/** The journey that applies to the user. v0: always onboarding (dec-6). */
export function activeJourney(): JourneyModule {
  return onboardingJourney;
}

/** Resolve a step view by id within the active journey (null if unknown). */
export function resolveStepView(stepId: string): JourneyStepView | null {
  return activeJourney().views[stepId] ?? null;
}
