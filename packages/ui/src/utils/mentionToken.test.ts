import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { activeMentionToken, replaceMentionToken } from './mentionToken';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-320/acs/ac-${n}`;

describe('spec-320 @-mention token detection (ac-5)', () => {
  it('opens on `@` and tracks the typed query up to the caret', () => {
    tagAc(AC(5));
    // Bare `@` → empty query (the composer shows the full roster).
    expect(activeMentionToken('@', 1)).toEqual({ query: '', start: 0 });
    // `@H` → query 'H'.
    expect(activeMentionToken('hey @H', 6)).toEqual({ query: 'H', start: 4 });
    // Mid-sentence after a space.
    expect(activeMentionToken('ping @harr now', 10)).toEqual({ query: 'harr', start: 5 });
  });

  it('does NOT trigger inside an email or mid-word, or after whitespace ends the token', () => {
    tagAc(AC(5));
    // `a@b` — the `@` is preceded by a word char, so no typeahead (emails are safe).
    expect(activeMentionToken('a@b', 3)).toBeNull();
    // A space after the token closes it.
    expect(activeMentionToken('@harry now', 10)).toBeNull();
    // No `@` at all.
    expect(activeMentionToken('hello world', 5)).toBeNull();
  });

  it('replaceMentionToken swaps the @token for the chosen label + trailing space', () => {
    tagAc(AC(5));
    const text = 'ping @harr done';
    const token = activeMentionToken('ping @harr', 10)!; // caret right after 'harr'
    const { text: next, caret } = replaceMentionToken(text, token.start, 10, 'Harry');
    expect(next).toBe('ping @Harry  done');
    expect(caret).toBe('ping @Harry '.length);
  });
});
