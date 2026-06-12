// spec-206 t-3 — the onboarding opening-context builder.
//
// Unit: the opening-context builder carries the required beats (ac-2/3/10/11).
// The builder survives the spec-242 rework unchanged — spec-229 hands it to
// `session.start()` when the user presses Turn on Mic, so these beats are still
// exactly what the guide speaks.
//
// The spec-206 CONTROLLER tests that lived here (auto-start on first session /
// no-op without audio / stamp-on-active — ac-1, ac-15, ac-16) are GONE with the
// behaviour they proved: spec-242 dec-2 superseded the auto-start (Specky now
// opens in text via the SpeckyDialogue card; voice begins only on the explicit
// Turn on Mic press). The replacement behaviour is proven in
// FirstRunGreeting.spec-242.test.tsx.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

import { buildOnboardingOpeningContext } from './FirstRunGreeting';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-206/acs/ac-${n}`;

describe('buildOnboardingOpeningContext (spec-206 ac-2/3/10/11)', () => {
  it('greets by first name and carries the value prop, orientation, invite, and offer', () => {
    const ctx = buildOnboardingOpeningContext('Ryan');
    expect(ctx).toContain('Ryan'); // ac-10: greet by first name
    expect(ctx.toLowerCase()).toContain('living spec'); // ac-2: value prop
    expect(ctx.toLowerCase()).toContain('phase columns'); // ac-2: on-screen orientation
    expect(ctx.toLowerCase()).toContain('ask'); // ac-3: invite questions
    expect(ctx.toLowerCase()).toContain('walk you through the demo specs'); // ac-3: offer
    expect(ctx.toLowerCase()).toContain('under a minute'); // ac-2: brevity
    tagAc(AC(2));
    tagAc(AC(3));
    tagAc(AC(10));
  });

  it('uses a warm nameless fallback when no name is available, never a placeholder', () => {
    const ctx = buildOnboardingOpeningContext(null);
    expect(ctx.toLowerCase()).toContain('hi there'); // warm nameless hello
    expect(ctx).not.toMatch(/\bnull\b/); // never a placeholder/empty name
    expect(ctx).not.toContain('undefined');
    tagAc(AC(11));
  });
});
