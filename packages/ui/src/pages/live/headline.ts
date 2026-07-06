// spec-458 dec-1/dec-5 — the honesty cascade, as a pure function so the tier
// selection is unit-testable (ac-9, ac-18) independently of rendering.
//
// The endpoint always returns true numbers; this decides which of them leads.
// A zero or sub-floor number never becomes the headline.

export interface HeadlineInputs {
  now: { humans: number; agents: number };
  lastHour: { events: number };
  totals: { specsCreatedThisWeek: number; decisionsResolvedThisWeek: number };
}

export type Headline =
  | { tier: 'now'; humans: number; agents: number }
  | { tier: 'hour'; events: number }
  | { tier: 'week'; specs: number; decisions: number };

export function selectHeadline(stats: HeadlineInputs, floor: number): Headline {
  const combined = stats.now.humans + stats.now.agents;
  if (combined >= floor) {
    return { tier: 'now', humans: stats.now.humans, agents: stats.now.agents };
  }
  if (stats.lastHour.events > 0) {
    return { tier: 'hour', events: stats.lastHour.events };
  }
  return {
    tier: 'week',
    specs: stats.totals.specsCreatedThisWeek,
    decisions: stats.totals.decisionsResolvedThisWeek,
  };
}
