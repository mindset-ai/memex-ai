// spec-206 first-run greeting behaviour — the opening context still greets by
// name (or a warm nameless fallback) and carries the value prop + orientation.
// spec-474 removed the demo-walkthrough offer, so that assertion is gone.

import { describe, it, expect } from 'vitest';
import { buildOnboardingOpeningContext } from '../../components/onboarding/FirstRunGreeting';

describe('spec-206 first-run greeting', () => {
  it('the first-run opening context greets by first name and carries the value prop', () => {
    const ctx = buildOnboardingOpeningContext('Ryan');
    expect(ctx).toContain('Ryan'); // still greets by name
    // The greeting still carries the value prop + orientation (spec-206 behaviour).
    expect(ctx.toLowerCase()).toContain('living spec');
  });

  it('still falls back to a warm nameless greeting when no name is available', () => {
    const ctx = buildOnboardingOpeningContext(null);
    expect(ctx.toLowerCase()).toContain('hi there');
    expect(ctx).not.toMatch(/\bnull\b/);
  });
});
