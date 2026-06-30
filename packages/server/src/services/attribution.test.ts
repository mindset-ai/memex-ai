// Unit tests for spec-21 t-4 attribution service utilities.
// Does not require a database connection — only the pure parsing/hashing functions.
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { parseAttributionCookie, hashEmail } from './attribution.js';

const AC8 = 'mindset-prod/memex-website/specs/spec-21/acs/ac-8';

describe('parseAttributionCookie (spec-21 t-4)', () => {
  it('extracts gclid and utm params from a Cookie header', () => {
    tagAc(AC8);
    const data = { gclid: 'abc123', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand' };
    const cookie = `_memex_attribution=${encodeURIComponent(JSON.stringify(data))}`;
    const result = parseAttributionCookie(cookie);
    expect(result?.gclid).toBe('abc123');
    expect(result?.utm_source).toBe('google');
    expect(result?.utm_medium).toBe('cpc');
    expect(result?.utm_campaign).toBe('brand');
  });

  it('extracts li_fat_id and oppref', () => {
    tagAc(AC8);
    const data = { li_fat_id: 'li456', oppref: 'oai789' };
    const cookie = `_memex_attribution=${encodeURIComponent(JSON.stringify(data))}`;
    const result = parseAttributionCookie(cookie);
    expect(result?.li_fat_id).toBe('li456');
    expect(result?.oppref).toBe('oai789');
  });

  it('returns null when Cookie header is null or empty', () => {
    tagAc(AC8);
    expect(parseAttributionCookie(null)).toBeNull();
    expect(parseAttributionCookie(undefined)).toBeNull();
    expect(parseAttributionCookie('')).toBeNull();
  });

  it('returns null when cookie is absent from a multi-cookie header', () => {
    tagAc(AC8);
    expect(parseAttributionCookie('session=abc; other=xyz')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    tagAc(AC8);
    const bad = `_memex_attribution=${encodeURIComponent('not-json')}`;
    expect(parseAttributionCookie(bad)).toBeNull();
  });

  it('works when _memex_attribution is not the first cookie', () => {
    tagAc(AC8);
    const data = { gclid: 'x' };
    const cookie = `session=s; _memex_attribution=${encodeURIComponent(JSON.stringify(data))}; other=o`;
    const result = parseAttributionCookie(cookie);
    expect(result?.gclid).toBe('x');
  });
});

describe('hashEmail (spec-21 t-4)', () => {
  it('produces a hex SHA-256 hash of the lowercased trimmed email', () => {
    tagAc(AC8);
    const h = hashEmail('test@example.com');
    // SHA-256 is always 64 hex chars
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises case and whitespace before hashing', () => {
    tagAc(AC8);
    expect(hashEmail('Test@Example.com')).toBe(hashEmail('test@example.com'));
    expect(hashEmail('  test@example.com  ')).toBe(hashEmail('test@example.com'));
  });

  it('produces different hashes for different emails', () => {
    tagAc(AC8);
    expect(hashEmail('a@a.com')).not.toBe(hashEmail('b@b.com'));
  });
});
