// spec-211 t-4 (ac-16): the spec-206 first-run greeting + walkthrough OFFER are
// unchanged by this fix — only what happens AFTER "yes" changed. We assert the
// spec-206 opening context still greets by name and still offers the walkthrough.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { buildOnboardingOpeningContext } from '../../components/onboarding/FirstRunGreeting';

const AC16 = 'mindset-prod/memex-building-itself/specs/spec-211/acs/ac-16';

describe('spec-206 greeting + offer unchanged (spec-211 ac-16)', () => {
  it('the first-run opening context still greets by first name and offers the walkthrough', () => {
    const ctx = buildOnboardingOpeningContext('Ryan');
    expect(ctx).toContain('Ryan'); // still greets by name
    expect(ctx.toLowerCase()).toContain('walk them through the demo specs'); // still offers it
    // The greeting still carries the value prop + orientation (spec-206 behaviour).
    expect(ctx.toLowerCase()).toContain('living spec');
    tagAc(AC16);
  });

  it('still falls back to a warm nameless greeting when no name is available', () => {
    const ctx = buildOnboardingOpeningContext(null);
    expect(ctx.toLowerCase()).toContain('hi there');
    expect(ctx).not.toMatch(/\bnull\b/);
  });
});
