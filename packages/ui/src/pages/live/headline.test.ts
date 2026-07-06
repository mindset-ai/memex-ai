// spec-458 t-1 — the dec-1/dec-5 honesty cascade (ac-9, ac-18).
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { selectHeadline } from './headline';

const AC = 'mindset-prod/memex-building-itself/specs/spec-458/acs';

const base = {
  now: { humans: 0, agents: 0 },
  lastHour: { events: 0 },
  totals: { specsCreatedThisWeek: 110, decisionsResolvedThisWeek: 588 },
};

describe('selectHeadline — the three-tier honesty cascade', () => {
  it('renders the live headcount only at/above the floor (combined humans+agents)', () => {
    tagAc(`${AC}/ac-9`);
    expect(
      selectHeadline({ ...base, now: { humans: 10, agents: 15 } }, 25),
    ).toEqual({ tier: 'now', humans: 10, agents: 15 });
    // One below the floor → never the headcount.
    expect(
      selectHeadline({ ...base, now: { humans: 10, agents: 14 }, lastHour: { events: 3 } }, 25).tier,
    ).toBe('hour');
  });

  it('falls back to last-hour events when sub-floor and events > 0', () => {
    tagAc(`${AC}/ac-9`);
    tagAc(`${AC}/ac-18`);
    tagAc(`${AC}/ac-4`);
    const h = selectHeadline({ ...base, now: { humans: 2, agents: 3 }, lastHour: { events: 41 } }, 25);
    expect(h).toEqual({ tier: 'hour', events: 41 });
  });

  it('falls back to weekly totals when the last hour is silent — a zero never leads', () => {
    tagAc(`${AC}/ac-9`);
    tagAc(`${AC}/ac-18`);
    tagAc(`${AC}/ac-4`);
    const h = selectHeadline(base, 25);
    expect(h).toEqual({ tier: 'week', specs: 110, decisions: 588 });
  });

  it('fallback tiers derive only from lastHour/totals — never the now counts (ac-18)', () => {
    tagAc(`${AC}/ac-18`);
    // Same sub-floor inputs with wildly different now counts → identical headline.
    const a = selectHeadline({ ...base, now: { humans: 0, agents: 0 }, lastHour: { events: 9 } }, 25);
    const b = selectHeadline({ ...base, now: { humans: 24, agents: 0 }, lastHour: { events: 9 } }, 25);
    expect(a).toEqual(b);
  });

  it('floor=0 always shows the live headcount (the always-on configuration)', () => {
    tagAc(`${AC}/ac-9`);
    expect(selectHeadline(base, 0).tier).toBe('now');
  });
});
