// Unit tests for the anonymous→signed-in conversion URL helpers (spec-111 t-8).
// UNTAGGED pure-function checks.

import { describe, it, expect } from 'vitest';
import { buildSignupUrl, readReturnTo } from './publicSignup';

describe('buildSignupUrl', () => {
  it('encodes the current path into a returnTo query param', () => {
    expect(buildSignupUrl('/acme/widgets/spec-1')).toBe(
      '/login?returnTo=%2Facme%2Fwidgets%2Fspec-1',
    );
  });

  it('preserves an existing query string by percent-encoding it', () => {
    const url = buildSignupUrl('/acme/widgets?tab=tasks');
    expect(url).toContain('returnTo=');
    expect(decodeURIComponent(url.split('returnTo=')[1])).toBe(
      '/acme/widgets?tab=tasks',
    );
  });

  it('falls back to root when the path is empty', () => {
    expect(buildSignupUrl('')).toBe('/login?returnTo=%2F');
  });
});

describe('readReturnTo', () => {
  it('extracts the returnTo param from a search string', () => {
    expect(readReturnTo('?returnTo=%2Facme%2Fwidgets')).toBe('/acme/widgets');
  });

  it('returns null when the param is absent', () => {
    expect(readReturnTo('?other=1')).toBeNull();
    expect(readReturnTo('')).toBeNull();
  });

  it('round-trips with buildSignupUrl', () => {
    const path = '/ns/mx/spec-42?focus=dec-1';
    const url = buildSignupUrl(path);
    const search = url.slice(url.indexOf('?'));
    expect(readReturnTo(search)).toBe(path);
  });
});
