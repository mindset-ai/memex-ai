// spec-389 t-4 (dec-3): the canonical cross-agent handoff map lives as guidance
// prose in the scaffold model (std-15 — one home, never inline). This test pins
// that the shared block names render_handoff and enumerates the canonical
// (requestedDomain → target) handoffs every agent must honour.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { SHARED_HANDOFF_GUIDANCE } from './scaffold-data.js';

const AC_HANDOFF =
  'mindset-prod/memex-building-itself/specs/spec-389/acs/ac-11';

describe('SHARED_HANDOFF_GUIDANCE — canonical handoff map (ac-11)', () => {
  it('is a react_only prompt block that tells the agent to use render_handoff', () => {
    tagAc(AC_HANDOFF);
    expect(SHARED_HANDOFF_GUIDANCE.kind).toBe('prompt_block');
    expect(SHARED_HANDOFF_GUIDANCE.surface).toBe('react_only');
    expect(SHARED_HANDOFF_GUIDANCE.text).toContain('render_handoff');
  });

  it('enumerates every canonical handoff target', () => {
    tagAc(AC_HANDOFF);
    const text = SHARED_HANDOFF_GUIDANCE.text.toLowerCase();
    expect(text).toContain('standards agent'); // create/edit a Standard
    expect(text).toContain('drift agent'); // resolve drift
    expect(text).toContain('new spec flow'); // needs a Spec
    expect(text).toContain('scaffold assistant'); // org guidance
    expect(text).toContain('coding agent'); // touch code
  });

  it('is honest about the boundary — refuse, do not pretend', () => {
    tagAc(AC_HANDOFF);
    const text = SHARED_HANDOFF_GUIDANCE.text.toLowerCase();
    expect(text).toMatch(/never pretend|refuse|hand off/);
  });
});
