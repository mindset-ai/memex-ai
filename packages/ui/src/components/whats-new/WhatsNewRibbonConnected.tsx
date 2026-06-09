// spec-200 t-7: wires the What's New ear to the spec-190 voice session.
//
// dec-6 (seed-the-guide): clicking an entry's ear starts a voice session seeded
// with that entry's text, so the guide (Specky) opens by explaining THAT entry.
// Kept separate from WhatsNewRibbon so the ribbon stays decoupled from the voice
// provider (and unit-testable without it). Rendered only inside VoiceGuideMount,
// so useVoiceSession always has its provider here.

import { useVoiceSession } from '../../voice/session/VoiceSessionContext';
import { isAffordanceDisabled } from '../../voice/session/voiceSessionModel';
import { WhatsNewRibbon } from './WhatsNewRibbon';
import type { WhatsNewEntry } from '../../api/whatsNew';

/** The seed text handed to the guide as guideContext for the opening turn. */
export function formatEntryForGuide(e: WhatsNewEntry): string {
  return `What's New — ${e.title}. What shipped: ${e.what} Why it matters: ${e.why}`;
}

export function WhatsNewRibbonConnected() {
  const session = useVoiceSession();
  // ac-14: hide the ear where the guide can't run (no mic / mic_unavailable) —
  // the same gate spec-190 uses for its own voice affordance. No orphaned ear.
  const guideAvailable = !isAffordanceDisabled(session);
  return (
    <WhatsNewRibbon
      onExplain={guideAvailable ? (e) => void session.start(formatEntryForGuide(e)) : undefined}
    />
  );
}
