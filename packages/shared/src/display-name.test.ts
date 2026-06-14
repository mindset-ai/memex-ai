// spec-259 dec-4 (ac-7, ac-13): the conservative display-name capitalization helper.
// It uppercases only a leading lowercase letter per token, preserves interior casing,
// and leaves email fallbacks and agent labels untouched.
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { capitalizeDisplayName } from './display-name.js';

const AC7 = 'mindset-prod/memex-building-itself/specs/spec-259/acs/ac-7';
const AC13 = 'mindset-prod/memex-building-itself/specs/spec-259/acs/ac-13';

describe('capitalizeDisplayName (spec-259 dec-4)', () => {
  it('title-cases a plain lowercase name', () => {
    tagAc(AC13);
    tagAc(AC7);
    expect(capitalizeDisplayName('barrie hadfield')).toBe('Barrie Hadfield');
  });

  it('preserves interior casing — never lowercases an interior capital', () => {
    tagAc(AC13);
    // Leading letter already uppercase → untouched; interior capitals kept.
    expect(capitalizeDisplayName('McDonald')).toBe('McDonald');
    expect(capitalizeDisplayName('DeShawn')).toBe('DeShawn');
    // Apostrophe is not a token boundary, so the interior letter is left as-is.
    expect(capitalizeDisplayName("o'brien")).toBe("O'brien");
    expect(capitalizeDisplayName("O'Brien")).toBe("O'Brien");
  });

  it('leaves email-derived fallbacks (containing "@") untouched', () => {
    tagAc(AC13);
    tagAc(AC7);
    expect(capitalizeDisplayName('barrie@mindset.ai')).toBe('barrie@mindset.ai');
  });

  it('leaves known agent labels untouched', () => {
    tagAc(AC13);
    expect(capitalizeDisplayName('Memex agent')).toBe('Memex agent');
    expect(capitalizeDisplayName('memex agent')).toBe('memex agent');
  });

  it('is a no-op on empty / nullish input', () => {
    tagAc(AC13);
    expect(capitalizeDisplayName('')).toBe('');
    expect(capitalizeDisplayName(null)).toBe('');
    expect(capitalizeDisplayName(undefined)).toBe('');
  });
});
