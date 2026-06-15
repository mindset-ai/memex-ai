// spec-259 dec-5 (ac-8, ac-14): the one canonical relative-age helper renders
// "Nd ago" deterministically against an INJECTED reference-now, and accepts both
// ISO strings and Date objects. Determinism is the property that lets MCP/agent
// output be asserted exactly under test.
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { timeAgo } from './relative-time.js';

const AC8 = 'mindset-prod/memex-building-itself/specs/spec-259/acs/ac-8';
const AC14 = 'mindset-prod/memex-building-itself/specs/spec-259/acs/ac-14';

describe('timeAgo — shared relative-age helper (spec-259 dec-5)', () => {
  // A fixed reference instant so every assertion is reproducible.
  const NOW = new Date('2026-06-14T12:00:00.000Z');

  it('renders the relative ladder deterministically against an injected now', () => {
    tagAc(AC14);
    tagAc(AC8);
    expect(timeAgo(new Date('2026-06-14T11:59:30.000Z'), NOW)).toBe('just now');
    expect(timeAgo(new Date('2026-06-14T11:45:00.000Z'), NOW)).toBe('15m ago');
    expect(timeAgo(new Date('2026-06-14T09:00:00.000Z'), NOW)).toBe('3h ago');
    expect(timeAgo(new Date('2026-06-11T12:00:00.000Z'), NOW)).toBe('3d ago');
    expect(timeAgo(new Date('2026-05-24T12:00:00.000Z'), NOW)).toBe('3w ago');
  });

  it('accepts ISO strings as well as Date objects (server carries Date, UI carries ISO)', () => {
    tagAc(AC14);
    expect(timeAgo('2026-06-11T12:00:00.000Z', NOW)).toBe('3d ago');
    expect(timeAgo(new Date('2026-06-11T12:00:00.000Z'), NOW)).toBe('3d ago');
  });

  it('clamps a clock-skew future instant to "just now" and is empty for bad/null input', () => {
    tagAc(AC14);
    expect(timeAgo(new Date('2026-06-14T12:05:00.000Z'), NOW)).toBe('just now');
    expect(timeAgo(null, NOW)).toBe('');
    expect(timeAgo('not-a-date', NOW)).toBe('');
  });

  it('falls back to an absolute date beyond ~8 weeks so "63w ago" never appears', () => {
    tagAc(AC8);
    // ~10 weeks before NOW.
    expect(timeAgo(new Date('2026-04-05T12:00:00.000Z'), NOW)).toMatch(/\d{1,2} \w{3} 2026/);
  });
});
