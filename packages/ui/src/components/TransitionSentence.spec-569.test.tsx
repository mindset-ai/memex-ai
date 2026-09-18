// spec-569 t-8 / dec-2 option (b) — a meaning-changed criterion gets its OWN
// blocker fragment, firing in any phase and with no decisions present.
//
// The decision path is deliberately untouched. spec-196 dec-2 gated it to
// `specify` + all-decisions-resolved for a reason the code states: while
// decisions are still open, consolidating is premature, because the prose will
// go stale again as they resolve. That reasoning is about DECISIONS. A
// superseded criterion will not move again — supersession arrives through
// spec-566's propose-and-accept gate, so it is deliberate, rare and terminal.
// Different churn, different gate; hence a second path rather than a wider one.
//
// ac-10 is the new behaviour. ac-11 is the regression guard that the old path
// did NOT move — without it a later reader reads (b) as a relaxation of
// spec-196, which is exactly what it is not.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SpecStatus } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-569/acs/ac-${n}`;

const updateDocStatus = vi.fn();
vi.mock('../api/client', () => ({
  updateDocStatus: (...a: unknown[]) => updateDocStatus(...a),
}));

import { TransitionSentence } from './TransitionSentence';

beforeEach(() => {
  vi.clearAllMocks();
  updateDocStatus.mockResolvedValue(undefined);
});

const DOC = { id: 'doc-1' };

function props(
  overrides: Partial<React.ComponentProps<typeof TransitionSentence>> = {},
) {
  return {
    doc: DOC,
    currentPhase: 'specify' as SpecStatus,
    viewedTab: 'specify' as SpecStatus,
    canTransition: false,
    totalDecisionCount: 2,
    openDecisionCount: 0,
    hasAcceptanceCriteria: true,
    totalTaskCount: 1,
    openTaskCount: 0,
    unverifiedAcCount: 0,
    ...overrides,
  };
}

// The component renders NOTHING when a phase has no blockers and no offer,
// so silence is legitimately an absent node — query, don't get.
const text = () =>
  (screen.queryByTestId('transition-sentence')?.textContent ?? '').trim();

describe('spec-569 dec-2(b) — criteria get their own staleness path (ac-10)', () => {
  it('fires in `build`, where spec-524 actually happened', () => {
    tagAc(AC(10));
    render(
      <TransitionSentence
        {...props({
          currentPhase: 'build',
          viewedTab: 'build',
          staleCriterionCount: 1,
        })}
      />,
    );
    expect(text()).toContain('The spec narrative');
    expect(text()).toContain('changed meaning');
    // It must not borrow the decision path's wording (ac-4).
    expect(text()).not.toContain('resolved decisions');
  });

  it('fires in `verify` too', () => {
    tagAc(AC(10));
    render(
      <TransitionSentence
        {...props({
          currentPhase: 'verify',
          viewedTab: 'verify',
          staleCriterionCount: 2,
        })}
      />,
    );
    expect(text()).toContain('criteria that changed meaning');
  });

  it('fires with ZERO decisions — the decision gate does not apply to it', () => {
    tagAc(AC(10));
    render(
      <TransitionSentence
        {...props({
          currentPhase: 'build',
          viewedTab: 'build',
          totalDecisionCount: 0,
          openDecisionCount: 0,
          staleCriterionCount: 1,
        })}
      />,
    );
    expect(text()).toContain('criterion that changed meaning');
  });

  it('stays out of `draft` — private authoring, nobody else is reading the prose', () => {
    tagAc(AC(10));
    // `viewedTab` must be a FORWARD tab, not the current phase. With
    // viewedTab === currentPhase the component returns null before the guard is
    // ever consulted, so the assertion would only say that '' lacks a
    // substring — true for any implementation. Caught in review by deleting the
    // guard and watching this file stay 8/8 green.
    render(
      <TransitionSentence
        {...props({
          currentPhase: 'draft',
          viewedTab: 'build',
          staleCriterionCount: 1,
        })}
      />,
    );
    expect(text()).not.toContain('changed meaning');
  });

  it('renders nothing at all from `done` — the blocker line is unreachable there', () => {
    tagAc(AC(10));
    // NOT `not.toContain('changed meaning')`. The guard's `done` half is
    // defence-in-depth and cannot be pinned: from `done` the blocker branch is
    // never taken (own tab → nextPhase('done') is null → early return; every
    // other tab is backward), so deleting that clause leaves any "does not
    // contain" assertion green. Measured in review across all four tabs ×
    // canTransition. So assert the thing that IS true and falsifiable — the
    // component renders nothing — which reds the day `done` gains a forward
    // move and the clause starts earning its keep.
    render(
      <TransitionSentence
        {...props({
          currentPhase: 'done',
          viewedTab: 'build',
          staleCriterionCount: 1,
        })}
      />,
    );
    expect(text()).toBe('');
  });

  it('does not double up when both a decision and a criterion are unreflected', () => {
    tagAc(AC(10));
    render(
      <TransitionSentence
        {...props({ narrativeStale: true, staleCriterionCount: 1 })}
      />,
    );
    // One narrative blocker, not two: the sentence would otherwise name "The
    // spec narrative" twice with two different requirements.
    const occurrences = text().split('The spec narrative').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('spec-569 ac-11 — the decision path did NOT move', () => {
  it('a stale decision still renders spec-196 dec-3 copy, verbatim', () => {
    tagAc(AC(11));
    render(<TransitionSentence {...props({ narrativeStale: true })} />);
    expect(text()).toContain(
      'The spec narrative must be updated to reflect the resolved decisions before this spec can move to Build — use the refresh action to generate the update prompt.',
    );
  });

  it('an OPEN decision still suppresses the narrative blocker (spec-196 gating intact)', () => {
    tagAc(AC(11));
    render(
      <TransitionSentence
        {...props({ openDecisionCount: 1, narrativeStale: true })}
      />,
    );
    expect(text()).toContain('must be resolved');
    expect(text()).not.toContain('The spec narrative');
  });

  it('a stale DECISION outside `specify` still stays silent — only criteria cross phases', () => {
    tagAc(AC(11));
    render(
      <TransitionSentence
        {...props({ currentPhase: 'build', viewedTab: 'build', narrativeStale: true })}
      />,
    );
    expect(text()).not.toContain('The spec narrative');
  });
});
