import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities } from './decodeHtmlEntities';

describe('decodeHtmlEntities', () => {
  it('decodes the encoded-title bug case (the reason this exists)', () => {
    // Legacy section titles were stored "Architecture &amp; Security".
    expect(decodeHtmlEntities('Architecture &amp; Security')).toBe('Architecture & Security');
    expect(decodeHtmlEntities('Design &amp; UX')).toBe('Design & UX');
  });

  it('leaves an already-clean title untouched (idempotent on clean input)', () => {
    expect(decodeHtmlEntities('Architecture & Security')).toBe('Architecture & Security');
    expect(decodeHtmlEntities('Plain title')).toBe('Plain title');
  });

  it('does not touch a bare ampersand that is not part of an entity', () => {
    expect(decodeHtmlEntities('Tom & Jerry & Co')).toBe('Tom & Jerry & Co');
    expect(decodeHtmlEntities('R&D budget')).toBe('R&D budget');
  });

  it('decodes the other named entities a title might carry', () => {
    expect(decodeHtmlEntities('a &lt; b &gt; c')).toBe('a < b > c');
    expect(decodeHtmlEntities('say &quot;hi&quot;')).toBe('say "hi"');
    expect(decodeHtmlEntities('it&apos;s here')).toBe("it's here");
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeHtmlEntities('&#39;quoted&#39;')).toBe("'quoted'");
    expect(decodeHtmlEntities('&#x26; sign')).toBe('& sign');
  });

  it('leaves an unknown entity verbatim rather than dropping it', () => {
    expect(decodeHtmlEntities('&notARealEntity; stays')).toBe('&notARealEntity; stays');
  });

  it('handles empty / entity-free input via the fast path', () => {
    expect(decodeHtmlEntities('')).toBe('');
    expect(decodeHtmlEntities('no entities here')).toBe('no entities here');
  });

  it('fully decodes multi-encoded values to a fixpoint (spec-484 t-1)', () => {
    // Some legacy rows were double-encoded. A single pass left a literal "&amp;" on
    // screen; the fixpoint loop resolves every layer: &amp;amp; -> &amp; -> &.
    expect(decodeHtmlEntities('A &amp;amp; B')).toBe('A & B');
  });
});
