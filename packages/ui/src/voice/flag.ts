// The voice-guide (Specky) kill-switch.
//
// Specky — the mic→STT→graph→TTS voice guide and its on-screen surfaces (the
// VoiceLayer pill/icon doorway, and the "Ask Specky to explain" ear on the
// What's New ribbon) — is hidden across the whole app by a SINGLE server-driven
// feature-hide slug, the same mechanism as `home`/`onboarding-wizard` (spec-146):
// `hiddenFeatures` rides the session payload from the `HIDDEN_FEATURES` env var.
// Adding `voice-guide` to that env hides every Specky surface — a config flip,
// NOT a redeploy or a code change. The guide-sdk package + server voice routes
// stay in the tree, so removing the slug brings Specky straight back.
//
// FAIL-OPEN by design: with the slug absent (the default), Specky is SHOWN.
// The flag exists only to turn it OFF.

import type { SessionPayload } from '../api/client';
import { isFeatureHidden } from '../utils/featureFlags';
import { useIsFeatureHidden } from '../hooks/useIsFeatureHidden';

/** The kill-switch slug. Present in `HIDDEN_FEATURES` ⇒ Specky hidden everywhere. */
export const VOICE_GUIDE_FLAG = 'voice-guide';

/** True unless the kill-switch slug is set — fail-open (shown by default). */
export function isVoiceGuideHidden(session: SessionPayload | null): boolean {
  return isFeatureHidden(session, VOICE_GUIDE_FLAG);
}

/** React hook form — re-renders call sites when a session refresh flips the flag. */
export function useVoiceGuideHidden(): boolean {
  return useIsFeatureHidden(VOICE_GUIDE_FLAG);
}
