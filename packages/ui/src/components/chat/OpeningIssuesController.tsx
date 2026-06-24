// spec-389 t-5 (dec-2) — the on-mount controller for the ISSUES agent's opening
// turn. Renders NOTHING. Mirror of OpeningDriftController / OpeningStandards-
// Controller: it flips ChatContext into 'issues' mode on mount and fires the
// agent ONCE to stream an opening turn that introduces itself and summarises the
// open Issues parking lot. On unmount it leaves the scoped mode. The seed is a
// scaffold-sourced instruction (ISSUES_OPENING_TURN_SEED, std-15) and the
// once-per-mount guard lives in ChatContext (startScopedOpeningTurn).

import { useEffect } from 'react';
import { ISSUES_OPENING_TURN_SEED } from '@memex/shared';
import { useChat } from '../ChatContext';

export function OpeningIssuesController() {
  const { enterIssuesMode, exitScopedMode, startScopedOpeningTurn, isIssuesMode } =
    useChat();

  useEffect(() => {
    enterIssuesMode();
    return () => exitScopedMode();
  }, [enterIssuesMode, exitScopedMode]);

  useEffect(() => {
    if (!isIssuesMode) return;
    startScopedOpeningTurn('issues', ISSUES_OPENING_TURN_SEED);
  }, [isIssuesMode, startScopedOpeningTurn]);

  return null;
}
