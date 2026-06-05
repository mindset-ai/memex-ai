import { describe, it, expect } from 'vitest';
import {
  derivePlanBadgeState,
  planStateLabel,
  PLAN_STATE_CLASSES,
} from './ExecutionPlanModal';

// Pure-helper tests for the t-17 plan badge derivation. The full modal renders
// through createPortal + fetches and is verified end-to-end by the e2e harness;
// here we only need to lock the state machine that drives the visible pill.

describe('derivePlanBadgeState', () => {
  it('returns approved when plan status === "approved" (t-20 W-B canonical state)', () => {
    expect(derivePlanBadgeState({ status: 'approved' }, null)).toBe('approved');
    expect(
      derivePlanBadgeState({ status: 'approved' }, 'NOT READY — gaps remain'),
    ).toBe('approved');
  });

  it('returns approved when plan status === "done" (legacy alias for pre-t-20 plans)', () => {
    expect(derivePlanBadgeState({ status: 'done' }, null)).toBe('approved');
    expect(derivePlanBadgeState({ status: 'done' }, 'NOT READY — gaps remain')).toBe(
      'approved',
    );
  });

  it('returns ready when readiness comment starts with READY', () => {
    expect(derivePlanBadgeState({ status: 'draft' }, 'READY — all green')).toBe('ready');
    // Case-insensitive — agents may write "Ready" or "ready".
    expect(derivePlanBadgeState({ status: 'draft' }, 'ready to ship')).toBe('ready');
  });

  it('returns not_ready when readiness comment starts with NOT READY (and not approved)', () => {
    expect(derivePlanBadgeState({ status: 'draft' }, 'NOT READY — open Qs')).toBe(
      'not_ready',
    );
  });

  it('returns submitted when no readiness assessment is present', () => {
    expect(derivePlanBadgeState({ status: 'draft' }, null)).toBe('submitted');
  });

  it('returns submitted when readiness content is freeform without a READY/NOT READY prefix', () => {
    expect(derivePlanBadgeState({ status: 'draft' }, 'partial — see notes')).toBe(
      'submitted',
    );
  });

  it('returns submitted when no plan is provided (defensive — should not happen in practice)', () => {
    expect(derivePlanBadgeState(null, null)).toBe('submitted');
  });
});

describe('planStateLabel', () => {
  it('maps each state to a user-readable label', () => {
    expect(planStateLabel('none')).toBe('No plan');
    expect(planStateLabel('submitted')).toBe('Submitted');
    expect(planStateLabel('ready')).toBe('READY');
    expect(planStateLabel('not_ready')).toBe('NOT READY');
    expect(planStateLabel('approved')).toBe('Approved');
  });
});

describe('PLAN_STATE_CLASSES', () => {
  it('exposes a class string for every state (so the badge never renders without colour)', () => {
    for (const state of ['none', 'submitted', 'ready', 'not_ready', 'approved'] as const) {
      expect(PLAN_STATE_CLASSES[state]).toBeTruthy();
      expect(typeof PLAN_STATE_CLASSES[state]).toBe('string');
    }
  });
});
