import { describe, it, expect } from 'vitest';
import { timeAgo } from './timeAgo';

// spec-286: the feed's relative-time helper. `now` is injected so the ladder is
// deterministic without faking the clock.
const NOW = new Date('2026-06-13T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('timeAgo', () => {
  it('reads "just now" under a minute (and clamps small future skew)', () => {
    expect(timeAgo(ago(30_000), NOW)).toBe('just now');
    expect(timeAgo(new Date(NOW.getTime() + 5_000).toISOString(), NOW)).toBe('just now');
  });

  it('coarsens through minutes, hours, days, weeks', () => {
    expect(timeAgo(ago(5 * MIN), NOW)).toBe('5m ago');
    expect(timeAgo(ago(3 * HOUR), NOW)).toBe('3h ago');
    expect(timeAgo(ago(2 * DAY), NOW)).toBe('2d ago');
    expect(timeAgo(ago(5 * WEEK), NOW)).toBe('5w ago');
  });

  it('falls back to an absolute date beyond ~8 weeks', () => {
    expect(timeAgo(ago(10 * WEEK), NOW)).toMatch(/\d{4}$/); // ends in a year
  });

  it('returns empty string for an unparseable input', () => {
    expect(timeAgo('not-a-date', NOW)).toBe('');
  });
});
