import { describe, it, expect, beforeEach } from 'vitest';
import { computeReturnLanding } from './AuthContext';
import { recordLastMemex, clearLastMemex } from '../utils/lastMemex';
import type { SessionPayload, MembershipSummary } from '../api/client';

// spec-502: returning to the app should land the user on the tenant they were last
// working in (persisted), not always their personal Memex — unless the remembered
// tenant is gone or is a read-only Explore/visited memex.

function sessionWith(memberships: MembershipSummary[]): SessionPayload {
  return {
    user: { id: 'u-1', email: 'a@b.co', name: 'A', status: 'active', emailVerified: true },
    memberships,
    currentMemexId: null,
    currentRole: null,
    needsOnboarding: false,
    hiddenFeatures: [],
  };
}

const personal: MembershipSummary = {
  memexId: 'mx-alice',
  slug: 'alice',
  memexSlug: 'personal',
  name: 'Personal',
  kind: 'personal',
  role: 'administrator',
};
const org: MembershipSummary = {
  memexId: 'mx-acme',
  slug: 'acme',
  memexSlug: 'main',
  name: 'Acme',
  kind: 'team',
  role: 'member',
};
const featured: MembershipSummary = {
  memexId: 'mx-featured',
  slug: 'mindset-prod',
  memexSlug: 'memex-building-itself',
  name: 'building-itself',
  kind: 'team',
  role: 'member',
  source: 'featured',
  accessLevel: 'read',
};

describe('computeReturnLanding (spec-502)', () => {
  beforeEach(() => clearLastMemex());

  it('falls back to the personal default when nothing is remembered', () => {
    expect(computeReturnLanding(sessionWith([personal, org]))).toBe('/alice/personal/home');
  });

  it('returns to the last-visited tenant when it is still a live membership', () => {
    recordLastMemex('acme', 'main');
    expect(computeReturnLanding(sessionWith([personal, org]))).toBe('/acme/main/home');
  });

  it('ignores a remembered tenant the user is no longer a member of', () => {
    recordLastMemex('acme', 'main');
    // Session no longer includes the acme membership → fall back to personal.
    expect(computeReturnLanding(sessionWith([personal]))).toBe('/alice/personal/home');
  });

  it('never auto-lands on a read-only Explore/visited memex', () => {
    recordLastMemex('mindset-prod', 'memex-building-itself');
    expect(computeReturnLanding(sessionWith([personal, featured]))).toBe('/alice/personal/home');
  });
});
