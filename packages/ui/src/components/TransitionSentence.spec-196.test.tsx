import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { TransitionSentence } from './TransitionSentence';
import type { SpecStatus } from '../api/types';

// spec-196 t-2 — the Rubicon line's narrative-staleness blocker (dec-2/dec-3).
//
// On the specify→build axis, once every decision is resolved, a stale
// narrative (any decision modified after narrativeLastConsolidatedAt — the
// shared isSpecNarrativeStale signal, threaded in as `narrativeStale`) blocks
// the advancement offer with the exact dec-3 copy. Once fresh, the offer
// renders. The blocker composes with the AC fragment, respects the non-editor
// status-only posture, and keeps the browse-tab escape hatch.
//
//   ac-8  : blockerFragments emits the staleness blocker for specify.
//   ac-9  : stale → blocker instead of offer; fresh → offer; escape hatch kept.
//   ac-10 : the exact dec-3 sentence, "The spec narrative" emphasised.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-196/acs/ac-${n}`;

const updateDocStatus = vi.fn();
vi.mock('../api/client', () => ({
  updateDocStatus: (...a: unknown[]) => updateDocStatus(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  updateDocStatus.mockResolvedValue(undefined);
});

const DOC = { id: 'doc-1' };

// Defaults: specify phase, decisions all resolved, ACs authored — a rubric
// that is clean EXCEPT where a test sets narrativeStale.
function baseProps(overrides: Partial<React.ComponentProps<typeof TransitionSentence>> = {}) {
  return {
    doc: DOC,
    currentPhase: 'specify' as SpecStatus,
    viewedTab: 'specify' as SpecStatus,
    totalDecisionCount: 2,
    openDecisionCount: 0,
    hasAcceptanceCriteria: true,
    totalTaskCount: 0,
    openTaskCount: 0,
    unverifiedAcCount: 0,
    ...overrides,
  };
}

function text() {
  return (screen.getByTestId('transition-sentence').textContent ?? '').trim();
}

describe('spec-196 — Rubicon narrative-staleness blocker at specify→build', () => {
  it('all decisions resolved + stale narrative → the dec-3 blocker, no advancement offer (ac-8, ac-9, ac-10)', () => {
    tagAc(AC(8));
    tagAc(AC(9));
    tagAc(AC(10));
    // Non-editor view: the blocker sentence stands alone (the spec-258/dec-5
    // editor override would otherwise append "Move … anyway?"). The dec-3
    // sentence itself is posture-independent — this pins its exact text.
    render(<TransitionSentence {...baseProps({ narrativeStale: true, canTransition: false })} />);

    // The exact dec-3 sentence.
    expect(text()).toBe(
      'The spec narrative must be updated to reflect the resolved decisions before this spec can move to Build — use the refresh action to generate the update prompt.',
    );
    // The entity carries the blocker emphasis.
    const sentence = screen.getByTestId('transition-sentence');
    const strong = sentence.querySelector('strong');
    expect(strong?.textContent).toBe('The spec narrative');
    // No offer, no buttons — shape 2 (blocked) has nothing to confirm.
    expect(text()).not.toContain('Do you wish');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('narrative fresh → the advancement offer renders (ac-9)', () => {
    tagAc(AC(9));
    render(<TransitionSentence {...baseProps({ narrativeStale: false })} />);
    expect(text()).toContain('Do you wish to move this spec to Build?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument();
  });

  it('open decisions lead alone — staleness waits until they are resolved (ac-8)', () => {
    tagAc(AC(8));
    render(
      <TransitionSentence {...baseProps({ openDecisionCount: 2, narrativeStale: true })} />,
    );
    expect(text()).toContain('2 Decisions must be resolved');
    expect(text()).not.toContain('spec narrative');
  });

  it('composes with the AC fragment under the shared renderer (ac-8)', () => {
    tagAc(AC(8));
    // Non-editor view pins the exact composed sentence (see above re: dec-5).
    render(
      <TransitionSentence
        {...baseProps({ narrativeStale: true, hasAcceptanceCriteria: false, canTransition: false })}
      />,
    );
    expect(text()).toBe(
      'The spec narrative must be updated to reflect the resolved decisions and Acceptance Criteria (ACs) must be created before this spec can move to Build — use the refresh action to generate the update prompt.',
    );
  });

  it('browse-tab escape hatch survives: blocker summary + "Move this spec anyway?" (ac-9)', async () => {
    tagAc(AC(9));
    const user = userEvent.setup();
    const onTransitioned = vi.fn();
    render(
      <TransitionSentence
        {...baseProps({ viewedTab: 'build', narrativeStale: true, onTransitioned })}
      />,
    );
    expect(text()).toContain(
      'The spec narrative must be updated to reflect the resolved decisions before Build — use the refresh action to generate the update prompt.',
    );
    expect(text()).toContain('Move this spec anyway?');

    // Yes still moves the phase — deliberate friction, not a hard gate.
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    expect(updateDocStatus).toHaveBeenCalledWith('doc-1', 'build');
  });

  it('non-editor posture stays status-only: blocker renders, no questions or buttons (ac-9)', () => {
    tagAc(AC(9));
    render(<TransitionSentence {...baseProps({ narrativeStale: true, canTransition: false })} />);
    expect(text()).toContain('The spec narrative must be updated');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('staleness is a specify-axis condition only — build→verify ignores it (ac-8)', () => {
    tagAc(AC(8));
    render(
      <TransitionSentence
        {...baseProps({
          currentPhase: 'build',
          viewedTab: 'build',
          narrativeStale: true,
          totalTaskCount: 2,
        })}
      />,
    );
    expect(text()).toContain('Do you want to move this spec to Verify?');
    expect(text()).not.toContain('spec narrative');
  });
});
