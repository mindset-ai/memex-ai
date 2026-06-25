// spec-143 t-4 (dec-6) / spec-389 (dec-1) — the on-mount controller for the DRIFT
// agent. Renders NOTHING. It flips ChatContext into drift mode on mount (so the
// ChatPanel input is live on arrival and the shared static AgentIntro shows) and
// leaves drift mode on unmount, restoring the default doc/creation agent.
//
// Per spec-389 dec-1 every in-app agent opens with a STATIC intro card (AGENT_INTROS),
// NOT a money-costing opening LLM turn — so, like the standards / issues / scaffold
// agents, this controller no longer fires an opening turn. The first real LLM call
// happens when the user types.

import { useEffect } from 'react';
import { useChat } from '../ChatContext';

export function OpeningDriftController() {
  const { enterDriftMode, exitDriftMode } = useChat();

  useEffect(() => {
    enterDriftMode();
    return () => exitDriftMode();
  }, [enterDriftMode, exitDriftMode]);

  return null;
}
