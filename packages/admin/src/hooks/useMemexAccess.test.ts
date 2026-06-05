import { describe, it, expect } from 'vitest';
import { resolveMemexAccess } from './useMemexAccess';
import type { MembershipSummary } from '../api/client';
import { tagAc } from "@memex-ai-ac/vitest";

const AC_NONMEMBER_READ =
  'mindset-prod/memex-building-itself/specs/spec-111/acs/ac-1';

function orgRow(over: Partial<MembershipSummary> = {}): MembershipSummary {
  return {
    memexId: 'mx-org',
    slug: 'acme',
    memexSlug: 'main',
    name: 'Acme',
    memexName: 'Main',
    kind: 'team',
    role: 'member',
    source: 'org',
    accessLevel: 'write',
    ...over,
  };
}

function visitedRow(over: Partial<MembershipSummary> = {}): MembershipSummary {
  return {
    memexId: 'mx-pub',
    slug: 'public-org',
    memexSlug: 'open-roadmap',
    name: 'Open Roadmap',
    memexName: 'Open Roadmap',
    kind: 'team',
    role: 'member',
    source: 'visited',
    accessLevel: 'read',
    ...over,
  };
}

describe('resolveMemexAccess', () => {
  it('grants write to an org member of the resolved memex', () => {
    tagAc(AC_NONMEMBER_READ);
    const access = resolveMemexAccess(
      { namespace: 'acme', memex: 'main' },
      [orgRow()],
      true,
    );
    expect(access.canWrite).toBe(true);
    expect(access.isReadOnly).toBe(false);
    expect(access.isVisitedReadOnly).toBe(false);
  });

  it('is read-only for a signed-in non-member on a visited public memex', () => {
    tagAc(AC_NONMEMBER_READ);
    const access = resolveMemexAccess(
      { namespace: 'public-org', memex: 'open-roadmap' },
      [orgRow(), visitedRow()],
      true,
    );
    expect(access.canWrite).toBe(false);
    expect(access.isReadOnly).toBe(true);
    expect(access.isVisitedReadOnly).toBe(true);
    expect(access.membership?.source).toBe('visited');
  });

  it('is read-only + unauthenticated for an anonymous visitor (no session)', () => {
    tagAc(AC_NONMEMBER_READ);
    const access = resolveMemexAccess(
      { namespace: 'public-org', memex: 'open-roadmap' },
      undefined,
      false,
    );
    expect(access.isAuthenticated).toBe(false);
    expect(access.canWrite).toBe(false);
    expect(access.membership).toBeNull();
  });

  it('does NOT leak write access across memexes (member of A, visitor of B)', () => {
    tagAc(AC_NONMEMBER_READ);
    // Caller writes Acme/main but only reads public-org/open-roadmap.
    const memberships = [orgRow(), visitedRow()];
    const onPublic = resolveMemexAccess(
      { namespace: 'public-org', memex: 'open-roadmap' },
      memberships,
      true,
    );
    expect(onPublic.canWrite).toBe(false);
    const onOrg = resolveMemexAccess(
      { namespace: 'acme', memex: 'main' },
      memberships,
      true,
    );
    expect(onOrg.canWrite).toBe(true);
  });

  it('treats a legacy row with no accessLevel/source as full-access (back-compat)', () => {
    tagAc(AC_NONMEMBER_READ);
    const legacy = orgRow({ source: undefined, accessLevel: undefined });
    const access = resolveMemexAccess(
      { namespace: 'acme', memex: 'main' },
      [legacy],
      true,
    );
    expect(access.canWrite).toBe(true);
  });
});
