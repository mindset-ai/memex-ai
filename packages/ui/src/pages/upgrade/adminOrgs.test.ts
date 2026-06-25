// spec-171 t-25 / ac-39 / dec-40 (option A): the upgrade/billing flows must bill
// a CHOSEN org, never the session's current (personal) Memex. deriveAdminOrgs is
// the resolution primitive — it must surface exactly the orgs the caller can be
// billed for, with a tenant base resolvable to each.

import { describe, it, expect } from 'vitest';
import { deriveAdminOrgs } from './adminOrgs';
import type { MembershipSummary, SessionPayload } from '../../api/client';

function session(memberships: MembershipSummary[]): SessionPayload {
  return {
    user: { id: 'u1', email: 'a@b.com', name: 'A', status: 'active', emailVerified: true },
    memberships,
    currentMemexId: null,
    currentRole: null,
    needsOnboarding: false,
    hiddenFeatures: [],
  };
}

const personal: MembershipSummary = {
  memexId: 'm-personal',
  slug: 'alice',
  memexSlug: 'main',
  name: 'Alice',
  kind: 'personal',
  role: 'administrator',
};

const adminOrg: MembershipSummary = {
  memexId: 'm-acme',
  orgId: 'org-acme',
  slug: 'acme',
  memexSlug: 'acme-memex',
  name: 'Acme Inc',
  kind: 'team',
  role: 'administrator',
};

describe('deriveAdminOrgs', () => {
  it('returns [] for null/undefined/empty session', () => {
    expect(deriveAdminOrgs(null)).toEqual([]);
    expect(deriveAdminOrgs(undefined)).toEqual([]);
    expect(deriveAdminOrgs(session([]))).toEqual([]);
  });

  it('excludes the personal namespace (never billable)', () => {
    expect(deriveAdminOrgs(session([personal]))).toEqual([]);
  });

  it('surfaces an admin org with a tenant base resolved to one of its memexes', () => {
    expect(deriveAdminOrgs(session([personal, adminOrg]))).toEqual([
      {
        orgId: 'org-acme',
        name: 'Acme Inc',
        namespace: 'acme',
        memexSlug: 'acme-memex',
      },
    ]);
  });

  it('excludes orgs where the caller is only a member (cannot bill)', () => {
    const memberOrg: MembershipSummary = { ...adminOrg, role: 'member' };
    expect(deriveAdminOrgs(session([memberOrg]))).toEqual([]);
  });

  it("excludes 'visited' read-only public-memex pins (not a real org membership)", () => {
    const visited: MembershipSummary = { ...adminOrg, source: 'visited' };
    expect(deriveAdminOrgs(session([visited]))).toEqual([]);
  });

  it('groups multiple memexes of one org into a single entry (first memex wins)', () => {
    const sibling: MembershipSummary = {
      ...adminOrg,
      memexId: 'm-acme-2',
      memexSlug: 'acme-second',
    };
    const orgs = deriveAdminOrgs(session([adminOrg, sibling]));
    expect(orgs).toHaveLength(1);
    expect(orgs[0].memexSlug).toBe('acme-memex');
  });

  it('returns every distinct admin org when the caller administers many', () => {
    const second: MembershipSummary = {
      memexId: 'm-globex',
      orgId: 'org-globex',
      slug: 'globex',
      memexSlug: 'globex-memex',
      name: 'Globex',
      kind: 'team',
      role: 'administrator',
    };
    const orgs = deriveAdminOrgs(session([adminOrg, second]));
    expect(orgs.map((o) => o.orgId)).toEqual(['org-acme', 'org-globex']);
  });

  it('skips admin team rows that lack an orgId (cannot group) or memexSlug (cannot route)', () => {
    const noOrgId: MembershipSummary = { ...adminOrg, orgId: null };
    const noMemexSlug: MembershipSummary = { ...adminOrg, memexSlug: '' };
    expect(deriveAdminOrgs(session([noOrgId, noMemexSlug]))).toEqual([]);
  });
});
