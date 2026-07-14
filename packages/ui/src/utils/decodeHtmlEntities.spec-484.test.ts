// spec-484 t-1 (dec-1) — the decode-on-read primitive.
//
//   ac-5  — double-encoded "&amp;amp;" decodes fully to "&" (fixpoint), while a
//           bare "&" and an entity-free string are left untouched.
//   ac-12 — an already-clean / entity-free title is returned unchanged (the
//           decoder is a no-op on data that carries no entity).
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { decodeHtmlEntities } from './decodeHtmlEntities';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

describe('spec-484: decodeHtmlEntities fixpoint decode', () => {
  it('ac-5: double-encoded "&amp;amp;" decodes fully to "&"', () => {
    tagAc(AC(5));
    // The core legacy bug: some rows were double-encoded. One pass would leave a
    // literal "&amp;" on screen; the fixpoint loop resolves every layer.
    expect(decodeHtmlEntities('Architecture &amp;amp; Security')).toBe('Architecture & Security');
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&');
    // Single-encoded still works (the common case).
    expect(decodeHtmlEntities('Design &amp; UX')).toBe('Design & UX');
  });

  it('ac-5: a bare "&" with no trailing entity is preserved', () => {
    tagAc(AC(5));
    expect(decodeHtmlEntities('Tom & Jerry')).toBe('Tom & Jerry');
    expect(decodeHtmlEntities('R&D budget')).toBe('R&D budget');
  });

  it('ac-5: unknown entities pass through verbatim', () => {
    tagAc(AC(5));
    expect(decodeHtmlEntities('&notARealEntity; stays')).toBe('&notARealEntity; stays');
  });

  it('ac-12: an entity-free / already-clean title is returned unchanged', () => {
    tagAc(AC(12));
    expect(decodeHtmlEntities('Plain title')).toBe('Plain title');
    expect(decodeHtmlEntities('Architecture & Security')).toBe('Architecture & Security');
    expect(decodeHtmlEntities('')).toBe('');
  });
});
