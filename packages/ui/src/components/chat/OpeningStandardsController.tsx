// spec-389 t-5 (dec-1/dec-2) — the on-mount controller for the STANDARDS agent.
// Renders NOTHING. It flips ChatContext into 'standards' mode on mount (so the
// ChatPanel input is live on arrival and the shared static AgentIntro shows) and
// leaves the scoped mode on unmount, restoring the default doc/creation agent.
//
// Per dec-1 the scoped agents open with a STATIC intro card (AGENT_INTROS), NOT a
// money-costing opening LLM turn — so, unlike the drift agent, this controller
// does not fire an opening turn. The first real LLM call happens when the user
// types. (Mirrors the scaffold surface, which is static for the same reason.)

import { useEffect } from 'react';
import { useChat } from '../ChatContext';

export function OpeningStandardsController() {
  const { enterStandardsMode, exitScopedMode } = useChat();

  useEffect(() => {
    enterStandardsMode();
    return () => exitScopedMode();
  }, [enterStandardsMode, exitScopedMode]);

  return null;
}
