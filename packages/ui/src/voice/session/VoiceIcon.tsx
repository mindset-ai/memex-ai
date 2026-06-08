// spec-190 t-8 (dec-5 / ac-1 / ac-29 / ac-31) — the in-view voice affordance. A
// static icon placed WITHIN the current screen's view (not the global top bar,
// ac-1), shown on every registered screen. Clicking it starts a session (which is
// what triggers the mic-permission prompt, ac-31). Disabled when no usable mic.
//
// SPECKY SLOT (spec-197): the visual identity (Specky) renders here. spec-197
// Slice 2 swaps the neutral placeholder below for the served specky.svg via the
// `mark` prop / children — this component owns placement + behaviour, spec-197
// owns the artwork. Until then a neutral glyph keeps the affordance discoverable.

import type { ReactNode } from 'react';
import { useVoiceSession } from './VoiceSessionContext';
import { isAffordanceDisabled } from './voiceSessionModel';

interface VoiceIconProps {
  /** The Specky artwork (spec-197). Falls back to a neutral placeholder glyph. */
  mark?: ReactNode;
}

export function VoiceIcon({ mark }: VoiceIconProps): React.JSX.Element {
  const session = useVoiceSession();
  const disabled = isAffordanceDisabled(session);
  const requesting = session.status === 'requesting_permission';

  return (
    <button
      type="button"
      data-voice-affordance
      aria-label={disabled ? 'Voice guide (microphone unavailable)' : 'Ask the voice guide'}
      title={disabled ? 'Microphone unavailable' : 'Ask the voice guide'}
      disabled={disabled || requesting}
      onClick={() => void session.start()}
      className="flex h-12 w-12 items-center justify-center rounded-full bg-surface shadow-lg ring-1 ring-border transition hover:scale-105 disabled:opacity-40 disabled:hover:scale-100"
    >
      {mark ?? <DefaultMark spinning={requesting} />}
    </button>
  );
}

/** Neutral placeholder until Specky lands (spec-197). A simple sound-wave glyph. */
function DefaultMark({ spinning }: { spinning: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-6 w-6 ${spinning ? 'animate-pulse' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="4" y1="10" x2="4" y2="14" />
      <line x1="9" y1="6" x2="9" y2="18" />
      <line x1="14" y1="8" x2="14" y2="16" />
      <line x1="19" y1="11" x2="19" y2="13" />
    </svg>
  );
}
