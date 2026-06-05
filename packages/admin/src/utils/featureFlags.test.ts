import { describe, it, expect } from 'vitest';
import { getHiddenFeatures, isFeatureHidden } from './featureFlags';
import type { SessionPayload } from '../api/client';

// spec-146 t-2 — PLAIN (untagged) unit test for the pure feature-hide
// predicates. No tagAc here on purpose: this file emits no AC events, so it is
// safe to run locally. The AC-9 background-refresh behaviour is covered by the
// tagged AuthContext test (the human runs that one against prod).

function sessionWith(hiddenFeatures: string[]): SessionPayload {
  return {
    user: { id: 'u-1', email: 'a@b.com', name: 'A', status: 'active', emailVerified: true },
    memberships: [],
    currentMemexId: null,
    currentRole: null,
    needsOnboarding: false,
    hiddenFeatures,
  };
}

describe('isFeatureHidden', () => {
  it('returns true when the slug is in hiddenFeatures', () => {
    expect(isFeatureHidden(sessionWith(['scaffold']), 'scaffold')).toBe(true);
  });

  it('returns false when the slug is absent from hiddenFeatures', () => {
    expect(isFeatureHidden(sessionWith(['pulse']), 'scaffold')).toBe(false);
  });

  it('fail-open: returns false when the session has no hiddenFeatures field', () => {
    // A session cached before this shipped (field absent on the wire).
    const legacy = { ...sessionWith([]) } as Partial<SessionPayload>;
    delete legacy.hiddenFeatures;
    expect(isFeatureHidden(legacy as SessionPayload, 'scaffold')).toBe(false);
  });

  it('fail-open: returns false when the session is null', () => {
    expect(isFeatureHidden(null, 'scaffold')).toBe(false);
  });
});

describe('getHiddenFeatures', () => {
  it('returns the slug list when present', () => {
    expect(getHiddenFeatures(sessionWith(['scaffold', 'pulse']))).toEqual(['scaffold', 'pulse']);
  });

  it('fail-open: returns [] when the session is null', () => {
    expect(getHiddenFeatures(null)).toEqual([]);
  });

  it('fail-open: returns [] when the hiddenFeatures field is missing', () => {
    const legacy = { ...sessionWith([]) } as Partial<SessionPayload>;
    delete legacy.hiddenFeatures;
    expect(getHiddenFeatures(legacy as SessionPayload)).toEqual([]);
  });
});
