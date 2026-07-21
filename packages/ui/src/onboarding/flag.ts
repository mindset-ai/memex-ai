// spec-502 t-1 (dec-5, ac-6/ac-14): the onboarding-wizard kill-switch.
//
// The Explore-first wizard ships to 100% of new signups, made reversible by a
// SINGLE server-driven feature-hide slug — the same mechanism as `home`/`scaffold`
// (spec-146): `hiddenFeatures` rides the session payload from the `HIDDEN_FEATURES`
// env var. Adding `onboarding-wizard` to that env disables the wizard and falls the
// flow back to the prior onboarding behaviour — a config flip, NOT a redeploy or a
// code change (ac-14).
//
// FAIL-OPEN by design: with the slug absent (the default), the wizard is ENABLED.
// This is the deliberate 100%-on rollout; the flag exists only to turn it OFF.

import type { SessionPayload } from '../api/client';
import { useAuth } from '../components/AuthContext';
import { isFeatureHidden } from '../utils/featureFlags';

/** The kill-switch slug. Present in `HIDDEN_FEATURES` ⇒ wizard OFF. */
export const ONBOARDING_WIZARD_FLAG = 'onboarding-wizard';

/** True unless the kill-switch slug is set — fail-open (enabled by default). */
export function isOnboardingWizardEnabled(session: SessionPayload | null): boolean {
  return !isFeatureHidden(session, ONBOARDING_WIZARD_FLAG);
}

/** React hook form — re-renders call sites when a session refresh flips the flag. */
export function useOnboardingWizardEnabled(): boolean {
  const { session } = useAuth();
  return isOnboardingWizardEnabled(session);
}
