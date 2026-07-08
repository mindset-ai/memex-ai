// spec-300 t-15 (dec-23) — the on-mount controller for the SKILLS agent. Renders
// NOTHING. It flips ChatContext into 'skills' mode on mount (so the ChatPanel input
// is live on arrival and the shared static AgentIntro shows) and leaves the scoped
// mode on unmount, restoring the default doc/creation agent.
//
// Like the standards / issues surfaces (spec-389 dec-1), the skills agent opens with
// a STATIC intro card (AGENT_INTROS.skills), NOT a money-costing opening LLM turn —
// so this controller fires no opening turn. The first real LLM call happens when the
// user types. Mirrors OpeningStandardsController.

import { useEffect } from 'react';
import { useChat } from '../ChatContext';

export function OpeningSkillsController() {
  const { enterSkillsMode, exitScopedMode } = useChat();

  useEffect(() => {
    enterSkillsMode();
    return () => exitScopedMode();
  }, [enterSkillsMode, exitScopedMode]);

  return null;
}
