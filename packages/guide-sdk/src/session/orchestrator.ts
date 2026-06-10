// spec-190 t-8 / t-3 — the seam between the session UX (t-8) and the
// mic→STT→graph→TTS loop (t-3 remaining). The provider owns the lifecycle + the
// granted mic stream and drives an orchestrator that implements this interface;
// the orchestrator reports live loop state + earcons back through the hooks. A
// no-op stub ships with t-8 so the UI (and Specky's wiring, spec-197) works
// before the real loop lands.

import type { Earcon, VoiceLoopState } from './voiceSessionModel';

/** Callbacks the orchestrator uses to drive the pill's live state (ac-29). */
export interface OrchestratorHooks {
  setLoopState: (s: VoiceLoopState) => void;
  playEarcon: (e: Earcon) => void;
  onError: (message: string) => void;
  /** The loop ended on its own (not a user `end()`); fold back to inactive. */
  onEnded: () => void;
  /** spec-211 t-1 (dec-1): an agent turn has fully played out (or settled with no
   *  speech / an error) and the loop is back to listening. The client tour
   *  sequencer awaits this to advance one phase only after narration finishes. */
  onTurnComplete?: () => void;
}

export interface VoiceOrchestrator {
  /** Begin the loop on an ALREADY-granted, AEC'd mic stream (the provider owns
   *  permission + the stream; the orchestrator consumes it — matches
   *  SileroWorkletVadEngine.start(stream, …)).
   *
   *  spec-200 t-7: `openingContext` (optional, additive) seeds the session so the
   *  guide proactively opens by explaining it — used by the What's New ear to make
   *  Specky explain a specific entry. Omitting it preserves today's behaviour. */
  start(stream: MediaStream, openingContext?: string): Promise<void> | void;
  /** Tap-to-interrupt / barge-in cut (dec-8). */
  interrupt(): void;
  /** Full teardown — close sockets, stop playback, release nodes. */
  stop(): void;
  /** spec-211 t-1 (dec-1): trigger a PROACTIVE narration turn (no user speech) for
   *  the demo walkthrough — `context` is the phase's fixture beat, fed to the guide
   *  as guideContext. Completion is signalled via `onTurnComplete`. No-op once
   *  stopped or while a session isn't running. */
  narratePhase(context: string): void;
}

export type OrchestratorFactory = (hooks: OrchestratorHooks) => VoiceOrchestrator;

/**
 * Default no-op orchestrator. t-8 ships the UX surface + this seam; the real
 * loop (t-3 remaining) plugs in by passing its own factory to the provider.
 * With the stub a started session sits in `listening` until the user ends it —
 * enough to build + demo the icon/pill (and wire Specky) ahead of the loop.
 */
export const stubOrchestratorFactory: OrchestratorFactory = (hooks) => ({
  start: () => {},
  interrupt: () => {},
  stop: () => {},
  // The stub has no audio loop, so a requested narration "completes" immediately
  // — keeps a client sequencer driving the stub from hanging on the await.
  narratePhase: () => hooks.onTurnComplete?.(),
});
