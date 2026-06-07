// spec-190 t-8 (dec-5) — the voice session's state model: the single source of
// truth the UI renders and the orchestrator (t-3 remaining) drives. Kept as pure
// types + helpers (no React) so it's unit-testable and so the orchestrator codes
// against a stable interface.
//
// Two axes:
//   - SessionStatus: the lifecycle (is there a session at all, and is the mic
//     usable). Governs whether the icon vs the pill shows, and the
//     permission-denied / mic-unavailable recovery states (ac-31).
//   - VoiceLoopState: WHEN active, the live conversational phase the pill
//     reflects (ac-29). Driven turn-by-turn by the orchestrator.

/** Session lifecycle. */
export type SessionStatus =
  | 'inactive' // no session — the in-view voice icon is shown
  | 'requesting_permission' // first start: mic permission prompt in flight
  | 'permission_denied' // user denied the mic — show recovery UI
  | 'mic_unavailable' // no mic / no mediaDevices — disabled affordance
  | 'active' // session running — the floating pill is shown
  | 'error'; // session-level error

/** The live voice-loop phase while a session is active (ac-29). */
export type VoiceLoopState =
  | 'idle' // active but between turns (transient)
  | 'listening' // mic open, capturing/awaiting speech
  | 'acknowledged' // end-of-speech ack blip (synced to the dec-6 ping)
  | 'thinking' // retrieval + LLM in flight
  | 'speaking' // TTS playing back
  | 'ducked'; // playback ducked by barge-in onset (dec-8)

/** Earcons — all emitted via app playback only (ac-31). */
export type Earcon = 'start' | 'ping' | 'end' | 'error';

export interface VoiceSessionState {
  status: SessionStatus;
  loopState: VoiceLoopState;
  muted: boolean;
  /** False when the browser exposes no usable mic — disables the affordance. */
  micAvailable: boolean;
  /** Last error message, surfaced in the error state. */
  error: string | null;
}

export function initialVoiceSessionState(micAvailable: boolean): VoiceSessionState {
  return {
    status: 'inactive',
    loopState: 'idle',
    muted: false,
    micAvailable,
    error: null,
  };
}

/** True while a session is live (the pill is shown instead of the icon). */
export function isSessionActive(s: VoiceSessionState): boolean {
  return s.status === 'active';
}

/** True when the icon affordance should render disabled (no usable mic). */
export function isAffordanceDisabled(s: VoiceSessionState): boolean {
  return !s.micAvailable || s.status === 'mic_unavailable';
}

/** Human label for the current pill state (spoken-UX copy, not a transcript). */
export function loopStateLabel(s: VoiceSessionState): string {
  if (s.muted) return 'Muted';
  switch (s.loopState) {
    case 'listening':
      return 'Listening…';
    case 'acknowledged':
      return 'Got it';
    case 'thinking':
      return 'Thinking…';
    case 'speaking':
      return 'Speaking…';
    case 'ducked':
      return 'Listening…'; // ducked = it heard you start talking over it
    case 'idle':
    default:
      return 'Ready';
  }
}
