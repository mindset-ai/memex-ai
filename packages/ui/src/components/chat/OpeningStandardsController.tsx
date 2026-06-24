// spec-389 t-5 (dec-2) — the on-mount controller for the STANDARDS agent's
// opening turn. Renders NOTHING. Mirror of OpeningDriftController: it flips
// ChatContext into 'standards' mode on mount (so the ChatPanel input is live on
// arrival) and fires the agent ONCE to stream an opening turn that introduces
// itself and notes how many Standards the Memex has. On unmount it leaves the
// scoped mode, restoring the default doc/creation agent. The seed is a single
// scaffold-sourced instruction (STANDARDS_OPENING_TURN_SEED, std-15) and the
// once-per-mount guard lives in ChatContext (startScopedOpeningTurn).

import { useEffect } from 'react';
import { STANDARDS_OPENING_TURN_SEED } from '@memex/shared';
import { useChat } from '../ChatContext';

export function OpeningStandardsController() {
  const { enterStandardsMode, exitScopedMode, startScopedOpeningTurn, isStandardsMode } =
    useChat();

  useEffect(() => {
    enterStandardsMode();
    return () => exitScopedMode();
  }, [enterStandardsMode, exitScopedMode]);

  useEffect(() => {
    if (!isStandardsMode) return;
    startScopedOpeningTurn('standards', STANDARDS_OPENING_TURN_SEED);
  }, [isStandardsMode, startScopedOpeningTurn]);

  return null;
}
