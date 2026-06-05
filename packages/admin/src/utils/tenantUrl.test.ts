import { describe, it, expect } from 'vitest';
import {
  parseTenantFromPathname,
  buildTenantUrl,
  buildBareDomainUrl,
  tenantPathFor,
  namespaceHomePath,
} from './tenantUrl';

// t-23 of doc-15: path-based tenant resolution.
describe('parseTenantFromPathname', () => {
  it('returns null for the bare root path', () => {
    expect(parseTenantFromPathname('/')).toBeNull();
  });

  it('returns null for caller-scoped prefixes (login, share, invite, settings, org, …)', () => {
    expect(parseTenantFromPathname('/login')).toBeNull();
    expect(parseTenantFromPathname('/share/abc123')).toBeNull();
    expect(parseTenantFromPathname('/invite/xyz')).toBeNull();
    expect(parseTenantFromPathname('/settings/tokens')).toBeNull();
    expect(parseTenantFromPathname('/org')).toBeNull();
    expect(parseTenantFromPathname('/install/mcp/auth')).toBeNull();
    expect(parseTenantFromPathname('/verify-email')).toBeNull();
    expect(parseTenantFromPathname('/verify-domain/tok')).toBeNull();
    expect(parseTenantFromPathname('/backstage')).toBeNull();
  });

  it('extracts namespace + memex from /<ns>/<mx>', () => {
    expect(parseTenantFromPathname('/acme/main')).toEqual({
      namespace: 'acme',
      memex: 'main',
    });
  });

  it('extracts namespace + memex from /<ns>/<mx>/specs', () => {
    expect(parseTenantFromPathname('/alice/personal/specs')).toEqual({
      namespace: 'alice',
      memex: 'personal',
    });
  });

  it('still extracts namespace + memex from the legacy /<ns>/<mx>/briefs alias', () => {
    expect(parseTenantFromPathname('/alice/personal/briefs')).toEqual({
      namespace: 'alice',
      memex: 'personal',
    });
  });

  it('still extracts namespace + memex from the legacy /<ns>/<mx>/missions alias', () => {
    expect(parseTenantFromPathname('/alice/personal/missions')).toEqual({
      namespace: 'alice',
      memex: 'personal',
    });
  });

  it('rejects invalid slug shapes (uppercase, leading hyphen, …)', () => {
    expect(parseTenantFromPathname('/Acme/main')).toBeNull();
    expect(parseTenantFromPathname('/-acme/main')).toBeNull();
    expect(parseTenantFromPathname('/acme/MAIN')).toBeNull();
  });

  it('returns null on a single segment', () => {
    expect(parseTenantFromPathname('/acme')).toBeNull();
  });

  it('supports nested paths beyond /<ns>/<mx>', () => {
    expect(parseTenantFromPathname('/acme/main/docs/doc-1')).toEqual({
      namespace: 'acme',
      memex: 'main',
    });
  });
});

describe('buildTenantUrl + buildBareDomainUrl + tenantPathFor', () => {
  it('buildTenantUrl prefixes path under origin/<ns>/<mx>', () => {
    // window.location defaults to http://localhost:3000 in jsdom (or similar).
    const url = buildTenantUrl('acme', 'main', '/specs');
    expect(url).toMatch(/^https?:\/\/[^/]+\/acme\/main\/specs$/);
  });

  it('buildBareDomainUrl returns origin/<path>', () => {
    const url = buildBareDomainUrl('/share/abc');
    expect(url).toMatch(/^https?:\/\/[^/]+\/share\/abc$/);
  });

  it('tenantPathFor produces the path part only', () => {
    expect(tenantPathFor('acme', 'main', '/docs/doc-1')).toBe(
      '/acme/main/docs/doc-1',
    );
    expect(tenantPathFor('alice', 'personal', '/specs')).toBe(
      '/alice/personal/specs',
    );
  });
});

describe('namespaceHomePath', () => {
  it('returns /<slug>/ for any valid namespace slug', () => {
    expect(namespaceHomePath('acme')).toBe('/acme/');
    expect(namespaceHomePath('alice')).toBe('/alice/');
    expect(namespaceHomePath('long-namespace-12')).toBe('/long-namespace-12/');
  });
});
