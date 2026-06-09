// spec-211 t-3 (dec-1/dec-3/dec-4): the client tour sequencer — the heart of the
// fix. When the user accepts the walkthrough, this drives a LINEAR, speech-synced
// loop: open the demo spec for the phase → narrate it → and only AFTER that
// narration finishes, show the board, advance one phase, open the next spec, and
// narrate again — through draft→specify→build→verify→done, then back to the board.
// It NEVER advances ahead of the narration (that was the burst bug), and it halts
// immediately if the Specky session is stopped mid-tour.

import type { RevealPhase } from '../../hooks/useHandholdReveal';

export interface DemoTourDeps {
  /** Lifecycle phases in order (REVEAL_PHASES). */
  phases: readonly RevealPhase[];
  /** True while the Specky session is still active — checked before every step so
   *  a Stop mid-tour halts the loop with no orphaned advance / open / board-nav. */
  isActive: () => boolean;
  /** Reset the reveal pointer to the first phase (draft) before the tour starts. */
  resetReveal: () => void;
  /** Advance the reveal pointer one phase (the board card moves a column). */
  advanceReveal: () => void;
  /** Detail-route path for the demo spec at a phase, or null if none is seeded. */
  openPath: (phase: RevealPhase) => string | null;
  /** Router navigate. */
  navigate: (path: string) => void;
  /** The Specs board path (where the tour starts the move + ends, dec-3). */
  boardPath: string;
  /** Trigger a proactive narration turn for `phase`; resolves when it finishes
   *  playing (spec-211 t-1 — the speech-sync primitive). */
  narratePhase: (phase: RevealPhase) => Promise<void>;
  /** Pause helper (a short beat on the board so the card move is visible). */
  pause: (ms: number) => Promise<void>;
  /** How long to dwell on the board after advancing so the move is seen. */
  boardPauseMs: number;
}

/**
 * Run the demo walkthrough. Resolves when the tour finishes or is halted (the
 * session ended). Pure orchestration over injected deps — no React, so it's
 * directly testable.
 */
export async function runDemoTour(d: DemoTourDeps): Promise<void> {
  if (!d.isActive()) return;
  // Always start at the first phase, even if the board pointer drifted.
  d.resetReveal();

  for (let i = 0; i < d.phases.length; i++) {
    if (!d.isActive()) return; // stopped → halt, no further work
    const phase = d.phases[i]!;

    if (i > 0) {
      // Show the board and move the card one column, so the user SEES the
      // advance — then dwell briefly before opening the next spec.
      d.navigate(d.boardPath);
      d.advanceReveal();
      await d.pause(d.boardPauseMs);
      if (!d.isActive()) return;
    }

    // Open the demo spec for this phase (its detail view), then narrate it.
    const path = d.openPath(phase);
    if (path) d.navigate(path);
    if (!d.isActive()) return;
    await d.narratePhase(phase); // resolves only when the spoken turn drains
  }

  // dec-3: end back on the board.
  if (d.isActive()) d.navigate(d.boardPath);
}
