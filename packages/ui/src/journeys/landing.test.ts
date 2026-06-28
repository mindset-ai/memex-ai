import { describe, it, expect, vi, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { shouldLandOnHome } from './landing';
import type { JourneyStateResponse } from '../api/journey';

// spec-421 dec-5 / issue-1 — the first-load landing predicate. Pure, read-only:
// the user has "finished getting started" once they've created their first spec
// (the hasSpec milestone). hasSpec ⇒ go to Specs (false); no spec yet / unknown ⇒ Home (true).
const ACS = 'mindset-prod/memex-building-itself/specs/spec-421/acs';

function stateWithSpec(hasSpec: boolean): JourneyStateResponse {
  return {
    milestones: {
      identityConfirmed: true,
      mcpConnected: true,
      mcpToolCalled: false,
      hasSpec,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
      planGrounded: false,
    },
    roleCoords: null,
    currentStepId: hasSpec ? 'resolve-decision' : 'create-first-spec',
    steps: [
      { id: 'identity', attained: true },
      { id: 'create-spec', attained: true },
      { id: 'create-first-spec', attained: hasSpec },
    ],
    preview: false,
    canPreview: false,
  };
}

describe('shouldLandOnHome — first-load landing predicate (spec-421 dec-5)', () => {
  it('no spec yet (still getting started) → land on Home (true)', () => {
    tagAc(`${ACS}/ac-15`);
    expect(shouldLandOnHome(stateWithSpec(false))).toBe(true);
  });

  it('has created their first spec (engaged) → go straight to Specs (false)', () => {
    tagAc(`${ACS}/ac-15`);
    expect(shouldLandOnHome(stateWithSpec(true))).toBe(false);
  });

  it('null / still-loading state → default to Home, never flash Specs (true)', () => {
    tagAc(`${ACS}/ac-15`);
    expect(shouldLandOnHome(null)).toBe(true);
  });

  it('does NOT require the full SDD loop — a first spec is enough, even with later milestones unmet', () => {
    tagAc(`${ACS}/ac-15`);
    // hasResolvedDecision / hasAc / planGrounded all false, but the user has a spec:
    // they are engaged and go to Specs. (isJourneyGraduated would keep them on Home.)
    expect(shouldLandOnHome(stateWithSpec(true))).toBe(false);
  });
});

describe('the landing decision is read-only — never persisted (spec-421 dec-5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('computing the predicate writes nothing to localStorage / sessionStorage', () => {
    tagAc(`${ACS}/ac-19`);
    const local = vi.spyOn(Storage.prototype, 'setItem');
    shouldLandOnHome(stateWithSpec(true));
    shouldLandOnHome(stateWithSpec(false));
    shouldLandOnHome(null);
    expect(local).not.toHaveBeenCalled();
  });
});
