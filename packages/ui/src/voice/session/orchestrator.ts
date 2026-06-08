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
}

export interface VoiceOrchestrator {
  /** Begin the loop on an ALREADY-granted, AEC'd mic stream (the provider owns
   *  permission + the stream; the orchestrator consumes it — matches
   *  SileroWorkletVadEngine.start(stream, …)). */
  start(stream: MediaStream): Promise<void> | void;
  /** Tap-to-interrupt / barge-in cut (dec-8). */
  interrupt(): void;
  setMuted(muted: boolean): void;
  /** Full teardown — close sockets, stop playback, release nodes. */
  stop(): void;
}

export type OrchestratorFactory = (hooks: OrchestratorHooks) => VoiceOrchestrator;

/**
 * Default no-op orchestrator. t-8 ships the UX surface + this seam; the real
 * loop (t-3 remaining) plugs in by passing its own factory to the provider.
 * With the stub a started session sits in `listening` until the user ends it —
 * enough to build + demo the icon/pill (and wire Specky) ahead of the loop.
 */
export const stubOrchestratorFactory: OrchestratorFactory = () => ({
  start: () => {},
  interrupt: () => {},
  setMuted: () => {},
  stop: () => {},
});
