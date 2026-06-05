// spec-143 t-4 (dec-6) — the on-mount controller for the DRIFT agent's opening
// turn. Renders NOTHING. The drift agent "comes to life" when the Drift Inbox
// mounts: this controller flips ChatContext into drift mode on mount (so the
// ChatPanel input is live on arrival) and fires the agent ONCE to stream an
// opening turn that summarizes the open Standards drift and suggests next
// actions. On unmount it leaves drift mode, restoring the default doc/creation
// agent for the rest of the app.
//
// Mirror of OpeningTurnController (the Spec on-open greeting), but drift is
// memex-scoped — there is no bound doc, no per-doc role, and no deterministic
// phase-button row, so the seed is a single scaffold-sourced instruction
// (DRIFT_OPENING_TURN_SEED, std-15: prose lives in @memex/shared) and the
// once-per-mount guard lives in ChatContext (startDriftOpeningTurn).

import { useEffect } from 'react';
import { DRIFT_OPENING_TURN_SEED } from '@memex/shared';
import { useChat } from '../ChatContext';

export function OpeningDriftController() {
  const { enterDriftMode, exitDriftMode, startDriftOpeningTurn, isDriftMode } = useChat();

  // Enter drift mode on mount, leave on unmount. Separated from the fire effect
  // so the cleanup reliably restores the default agent even if the fire effect
  // re-runs. enterDriftMode is idempotent (no-op if already in drift mode).
  useEffect(() => {
    enterDriftMode();
    return () => exitDriftMode();
  }, [enterDriftMode, exitDriftMode]);

  // Once drift mode is active, fire the opening turn. The once-per-entry guard
  // lives in ChatContext (startDriftOpeningTurn), so re-runs are no-ops.
  useEffect(() => {
    if (!isDriftMode) return;
    startDriftOpeningTurn(DRIFT_OPENING_TURN_SEED);
  }, [isDriftMode, startDriftOpeningTurn]);

  return null;
}
