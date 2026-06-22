// spec-337 — the UI journey-state client's JourneyMilestones shape exposes
// planGrounded, so the rail orbs + the progress % can read the codebase-grounding
// signal for the 'Specs that match reality' step. The typed literal below only
// compiles if the interface carries planGrounded (and exactly the milestone keys).
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import type { JourneyMilestones } from './journey';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-337/acs/ac-${n}`;

describe('spec-337 — UI JourneyMilestones exposes planGrounded', () => {
  it('planGrounded is part of the UI milestones shape (ac-5, ac-3)', () => {
    tagAc(AC(5));
    tagAc(AC(3));
    const m: JourneyMilestones = {
      identityConfirmed: false,
      mcpConnected: false,
      mcpToolCalled: false,
      hasSpec: false,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
      planGrounded: false,
    };
    expect('planGrounded' in m).toBe(true);
    expect(typeof m.planGrounded).toBe('boolean');
  });
});
