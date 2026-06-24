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

const MODES = Object.keys(AGENT_INTROS) as AgentChatMode[];

describe('AgentIntro — shared static intro card (ac-1, ac-5)', () => {
  it('every agent mode has a registry entry with a lead + bullets', () => {
    tagAc(AC_VISUAL);
    tagAc(AC_SINGLE_SOURCED);
    for (const mode of MODES) {
      expect(AGENT_INTROS[mode].lead.length).toBeGreaterThan(0);
      expect(AGENT_INTROS[mode].bullets.length).toBeGreaterThan(0);
    }
    // The five surfaces the Spec unifies are all covered.
    expect(MODES.sort()).toEqual(
      ['drift', 'issues', 'scaffold', 'spec', 'standards'].sort(),
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
});
