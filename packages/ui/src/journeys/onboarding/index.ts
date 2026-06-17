// spec-303 — the onboarding journey module. Bundles this journey's step views +
// its server-derived step order behind the engine's JourneyModule contract.
import type { JourneyModule } from '../types';
import { ONBOARDING_STEP_VIEWS, ONBOARDING_MILESTONE_STEP_IDS } from './steps';

export const onboardingJourney: JourneyModule = {
  id: 'onboarding',
  views: ONBOARDING_STEP_VIEWS,
  milestoneStepIds: ONBOARDING_MILESTONE_STEP_IDS,
};
