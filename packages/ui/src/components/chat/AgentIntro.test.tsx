// spec-389 t-1 (dec-1): the shared static intro card. Pins that every in-app
// agent mode has a single-sourced, no-LLM intro (ac-1) rendered from one
// component + registry (ac-5).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { AgentIntro } from './AgentIntro';
import { AGENT_INTROS, type AgentChatMode } from './agentIntros';

// ac-1 (scope): every in-app agent presents the same chat-panel visual
// attributes, incl. a static no-LLM intro card.
const AC_VISUAL = 'mindset-prod/memex-building-itself/specs/spec-389/acs/ac-1';
// ac-5 (scope): the shared attributes are single-sourced and reused, not
// duplicated per mode.
const AC_SINGLE_SOURCED =
  'mindset-prod/memex-building-itself/specs/spec-389/acs/ac-5';
// spec-300 t-15 (dec-23): ac-52 — the Skills page mounts the shared ChatPanel with
// an AGENT_INTROS.skills intro card (one registry, no per-mode copy).
const AC_SKILLS_INTRO =
  'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-52';

const MODES = Object.keys(AGENT_INTROS) as AgentChatMode[];

describe('AgentIntro — shared static intro card (ac-1, ac-5)', () => {
  it('every agent mode has a registry entry with a lead + bullets', () => {
    tagAc(AC_VISUAL);
    tagAc(AC_SINGLE_SOURCED);
    for (const mode of MODES) {
      expect(AGENT_INTROS[mode].lead.length).toBeGreaterThan(0);
      expect(AGENT_INTROS[mode].bullets.length).toBeGreaterThan(0);
    }
    // All the unified surfaces are covered — spec-300 t-15 adds 'skills' as the
    // sixth scoped agent card.
    expect(MODES.sort()).toEqual(
      ['drift', 'issues', 'scaffold', 'skills', 'spec', 'standards'].sort(),
    );
  });

  for (const mode of ['scaffold', 'standards', 'issues'] as AgentChatMode[]) {
    it(`renders the ${mode} intro from the registry (no LLM call)`, () => {
      tagAc(AC_VISUAL);
      render(<AgentIntro mode={mode} />);
      expect(screen.getByTestId(`agent-intro-${mode}`)).toBeInTheDocument();
      expect(screen.getByText(AGENT_INTROS[mode].lead)).toBeInTheDocument();
      // Each bullet is rendered.
      for (const bullet of AGENT_INTROS[mode].bullets) {
        expect(screen.getByText(bullet)).toBeInTheDocument();
      }
    });
  }

  it('renders the skills intro from the registry (no LLM call) (spec-300 ac-52)', () => {
    tagAc(AC_SKILLS_INTRO);
    render(<AgentIntro mode="skills" />);
    expect(screen.getByTestId('agent-intro-skills')).toBeInTheDocument();
    expect(screen.getByText(AGENT_INTROS.skills.lead)).toBeInTheDocument();
    for (const bullet of AGENT_INTROS.skills.bullets) {
      expect(screen.getByText(bullet)).toBeInTheDocument();
    }
  });
});
