import { describe, it, expect } from 'vitest';
import { parseTagInput, formatTagInput, tagKey, tagMatchesQuery } from './tagInput';

// UNTAGGED — pure util tests, safe to run from automation. Mirrors the server's
// parseTagInput contract (packages/server/src/services/tags.ts) but returns null
// instead of throwing on invalid input.
describe('parseTagInput', () => {
  it('parses a scoped tag on the first `::`', () => {
    expect(parseTagInput('priority::high')).toEqual({ scope: 'priority', value: 'high' });
  });

  it('treats a bare value as a flat tag (scope null)', () => {
    expect(parseTagInput('bug')).toEqual({ scope: null, value: 'bug' });
  });

  it('splits only on the FIRST `::` — value may contain `::`', () => {
    expect(parseTagInput('a::b::c')).toEqual({ scope: 'a', value: 'b::c' });
  });

  it('treats an empty scope as flat', () => {
    expect(parseTagInput('::high')).toEqual({ scope: null, value: 'high' });
  });

  it('trims surrounding whitespace on scope and value', () => {
    expect(parseTagInput('  priority :: high  ')).toEqual({ scope: 'priority', value: 'high' });
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(parseTagInput('')).toBeNull();
    expect(parseTagInput('   ')).toBeNull();
  });

  it('returns null when the value side is empty (priority::)', () => {
    expect(parseTagInput('priority::')).toBeNull();
    expect(parseTagInput('priority::   ')).toBeNull();
  });
});

describe('formatTagInput', () => {
  it('renders a scoped tag as scope::value', () => {
    expect(formatTagInput({ scope: 'priority', value: 'high' })).toBe('priority::high');
  });

  it('renders a flat tag as just the value', () => {
    expect(formatTagInput({ scope: null, value: 'bug' })).toBe('bug');
  });
});

describe('tagKey', () => {
  it('collapses null and empty-string scope to the same flat key', () => {
    expect(tagKey({ scope: null, value: 'bug' })).toBe(tagKey({ scope: '', value: 'bug' }));
  });

  it('distinguishes scoped from flat with the same value', () => {
    expect(tagKey({ scope: 'team', value: 'core' })).not.toBe(
      tagKey({ scope: null, value: 'core' }),
    );
  });
});

describe('tagMatchesQuery', () => {
  it('matches case-insensitively against the formatted string', () => {
    expect(tagMatchesQuery({ scope: 'priority', value: 'high' }, 'HIGH')).toBe(true);
    expect(tagMatchesQuery({ scope: 'priority', value: 'high' }, 'prio')).toBe(true);
  });

  it('matches everything for an empty query', () => {
    expect(tagMatchesQuery({ scope: null, value: 'bug' }, '')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(tagMatchesQuery({ scope: null, value: 'bug' }, 'feature')).toBe(false);
  });
});
