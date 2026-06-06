import { useCallback, useState } from 'react';
import type { SpecStatus } from '../api/types';

/**
 * spec-178 t-10 (dec-10): progressive reveal of the five Handhold demo specs.
 *
 * All five demo specs (one per phase) are seeded into the personal Memex, but
 * the board shows only ONE at a time — the one whose `status` matches a
 * client-side pointer. Advancing the pointer makes the current demo card
 * disappear and the next phase's demo card appear, giving the impression of a
 * single spec walking across the board (draft → plan → build → verify → done).
 *
 * The pointer is purely a UI affordance for the walkthrough, so it lives in
 * localStorage (no server state — this is CLIENT-SIDE ONLY, dec-10). It is
 * keyed by namespace/memex so each personal Memex tracks its own progress and
 * one user's walkthrough never bleeds into another tenant's board.
 */

// dec-4 Spec lifecycle order. The demo walks these in sequence; `done` is the
// terminal phase (no "next" — the advance control becomes Reset there).
export const REVEAL_PHASES = ['draft', 'plan', 'build', 'verify', 'done'] as const;
export type RevealPhase = (typeof REVEAL_PHASES)[number];

const DEFAULT_PHASE: RevealPhase = 'draft';

// Storage key per dec-10: `handhold-reveal:${ns}/${mx}`. A null tenant (e.g. a
// caller-scoped route with no Memex) collapses to a single shared key — the
// hook is still safe to call, it just won't be tenant-scoped.
function storageKey(ns: string | null, mx: string | null): string {
  return `handhold-reveal:${ns ?? '_'}/${mx ?? '_'}`;
}

function isRevealPhase(value: string | null): value is RevealPhase {
  return value != null && (REVEAL_PHASES as readonly string[]).includes(value);
}

function readPointer(key: string): RevealPhase {
  if (typeof window === 'undefined') return DEFAULT_PHASE;
  try {
    const raw = window.localStorage.getItem(key);
    return isRevealPhase(raw) ? raw : DEFAULT_PHASE;
  } catch {
    // localStorage can throw under privacy modes / disabled storage — fall back
    // to the default rather than crashing the board.
    return DEFAULT_PHASE;
  }
}

function writePointer(key: string, phase: RevealPhase): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, phase);
  } catch {
    // Silent on storage failures — the in-memory state still drives the render
    // this session; only cross-navigation persistence is lost.
  }
}

export interface HandholdReveal {
  /** The single demo phase currently revealed on the board. Default 'draft'. */
  revealedPhase: RevealPhase;
  /**
   * Move the pointer to the next phase in the lifecycle. No-op at 'done' (the
   * terminal phase) — callers wire the done-phase control to `reset()` instead.
   */
  advance: () => void;
  /** Restore the pointer to 'draft' so only the first demo spec shows again. */
  reset: () => void;
}

/**
 * Returns the reveal pointer for the given tenant plus advance/reset actions.
 * Lazily reads localStorage on first render so the user's progress survives
 * navigation; writes through on every mutation. `revealedPhase` is `SpecStatus`-
 * compatible so call sites can compare it directly against a card's `status`.
 */
export function useHandholdReveal(
  ns: string | null,
  mx: string | null,
): HandholdReveal {
  const key = storageKey(ns, mx);
  const [revealedPhase, setRevealedPhase] = useState<RevealPhase>(() => readPointer(key));

  const advance = useCallback(() => {
    setRevealedPhase((current) => {
      const idx = REVEAL_PHASES.indexOf(current);
      // Clamp at the terminal phase — there is no phase after 'done'.
      const next = idx >= 0 && idx < REVEAL_PHASES.length - 1 ? REVEAL_PHASES[idx + 1]! : current;
      if (next !== current) writePointer(key, next);
      return next;
    });
  }, [key]);

  const reset = useCallback(() => {
    writePointer(key, DEFAULT_PHASE);
    setRevealedPhase(DEFAULT_PHASE);
  }, [key]);

  return { revealedPhase, advance, reset };
}

/** The phase that follows `phase`, or null at the terminal 'done'. Exposed for
 *  the advance control's "See it in <next> →" label. */
export function nextRevealPhase(phase: RevealPhase): RevealPhase | null {
  const idx = REVEAL_PHASES.indexOf(phase);
  if (idx < 0 || idx >= REVEAL_PHASES.length - 1) return null;
  return REVEAL_PHASES[idx + 1]!;
}

// Re-export the SpecStatus alias for call sites that thread the phase into
// status-typed props without importing both modules.
export type { SpecStatus };
