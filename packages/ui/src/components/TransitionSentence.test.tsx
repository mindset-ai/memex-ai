import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { TransitionSentence } from './TransitionSentence';
import type { SpecStatus } from '../api/types';

// spec-159 t-3 — the Rubicon line (dec-4, second amendment 2026-06-04;
// shortened 2026-06-04: no "This spec is currently in {phase}." lead — the tab
// bar's filled current-phase pill carries that):
//   shape 1: current tab + rubric clean → advancement offer + [Yes]
//   shape 2: current tab + rubric blocked → exact outstanding-work summary, NO buttons
//   shape 3: browsing another tab → explicit confirm [Yes] [No]; forward+blocked
//            leads with the blocker summary and asks "Move this spec anyway?";
//            No returns to the current tab
//   ac-3 / ac-13: the line always states the rubric's exact condition.
//   ac-4 / ac-16: backward moves never gated; Yes is the only phase mutation.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-159/acs/ac-${n}`;

const updateDocStatus = vi.fn();
vi.mock('../api/client', () => ({
  updateDocStatus: (...a: unknown[]) => updateDocStatus(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  updateDocStatus.mockResolvedValue(undefined);
});

const DOC = { id: 'doc-1' };

// Defaults are a CLEAN rubric for every phase (decisions resolved, ACs
// authored + verified, tasks created + complete).
function baseProps(overrides: Partial<React.ComponentProps<typeof TransitionSentence>> = {}) {
  return {
    doc: DOC,
    currentPhase: 'plan' as SpecStatus,
    viewedTab: 'plan' as SpecStatus,
    totalDecisionCount: 2,
    openDecisionCount: 0,
    hasAcceptanceCriteria: true,
    totalTaskCount: 2,
    openTaskCount: 0,
    unverifiedAcCount: 0,
    ...overrides,
  };
}

function text() {
  return (screen.getByTestId('transition-sentence').textContent ?? '').trim();
}

describe('Rubicon line — shape 1: current tab, rubric clean → offer + Yes', () => {
  it('carries NO status lead — the tab bar already names the current phase', () => {
    tagAc(AC(3));
    render(<TransitionSentence {...baseProps({ currentPhase: 'build', viewedTab: 'build' })} />);
    expect(text()).not.toContain('currently in');
    expect(text()).toContain('Do you want to move this spec to Verify?');
  });

  it('draft → offers plan (draft is never gated)', () => {
    tagAc(AC(3));
    tagAc(AC(13));
    render(
      <TransitionSentence
        {...baseProps({
          currentPhase: 'draft',
          viewedTab: 'plan',
          totalDecisionCount: 0,
          hasAcceptanceCriteria: false,
        })}
      />,
    );
    expect(text()).toContain('Do you wish to move this spec to Specify?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'No' })).toBeNull();
  });

  it('plan (clean) → "Do you wish to move this spec to Build?" + Yes', () => {
    tagAc(AC(3));
    tagAc(AC(13));
    render(<TransitionSentence {...baseProps()} />);
    expect(text()).toContain('Do you wish to move this spec to Build?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
  });

  it('build (clean) → "Do you want to move this spec to Verify?" + Yes', () => {
    tagAc(AC(3));
    tagAc(AC(13));
    render(<TransitionSentence {...baseProps({ currentPhase: 'build', viewedTab: 'build' })} />);
    expect(text()).toContain('Do you want to move this spec to Verify?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
  });

  it('verify (clean) → "Do you want to move this spec to Done?" + Yes', () => {
    tagAc(AC(3));
    tagAc(AC(13));
    render(<TransitionSentence {...baseProps({ currentPhase: 'verify', viewedTab: 'verify' })} />);
    expect(text()).toContain('Do you want to move this spec to Done?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
  });
});

describe('Rubicon line — shape 2: current tab, rubric blocked → exact status, NO buttons', () => {
  it('plan with no decisions and no ACs → combined summary, no buttons', () => {
    tagAc(AC(3));
    tagAc(AC(13));
    render(
      <TransitionSentence
        {...baseProps({ totalDecisionCount: 0, hasAcceptanceCriteria: false })}
      />,
    );
    expect(text()).toContain(
      'Decisions and Acceptance Criteria (ACs) must be created before this spec can move to Build.',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('plan with open decisions and ACs present → decisions-only summary', () => {
    tagAc(AC(13));
    render(<TransitionSentence {...baseProps({ openDecisionCount: 4 })} />);
    expect(text()).toContain('4 Decisions must be resolved before this spec can move to Build.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('singular grammar: 1 open decision → "1 Decision must be resolved"', () => {
    tagAc(AC(13));
    render(<TransitionSentence {...baseProps({ openDecisionCount: 1 })} />);
    expect(text()).toContain('1 Decision must be resolved before this spec can move to Build.');
  });

  it('build with open tasks → "{N} Tasks must be completed before this spec can move to Verify."', () => {
    tagAc(AC(13));
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'build', viewedTab: 'build', openTaskCount: 2 })}
      />,
    );
    expect(text()).toContain('2 Tasks must be completed before this spec can move to Verify.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('verify with unverified ACs → "{N} Acceptance Criteria (ACs) must be verified before this spec can move to Done."', () => {
    tagAc(AC(13));
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'verify', viewedTab: 'verify', unverifiedAcCount: 3 })}
      />,
    );
    expect(text()).toContain('3 Acceptance Criteria (ACs) must be verified before this spec can move to Done.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('build with ZERO tasks is blocked — an empty build never offers verify', () => {
    tagAc(AC(13));
    render(
      <TransitionSentence
        {...baseProps({
          currentPhase: 'build',
          viewedTab: 'build',
          totalTaskCount: 0,
          openTaskCount: 0,
        })}
      />,
    );
    expect(text()).toContain('Tasks must be created and completed before this spec can move to Verify.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('verify with NO active ACs is blocked — nothing to verify against', () => {
    tagAc(AC(13));
    render(
      <TransitionSentence
        {...baseProps({
          currentPhase: 'verify',
          viewedTab: 'verify',
          hasAcceptanceCriteria: false,
          unverifiedAcCount: 0,
        })}
      />,
    );
    expect(text()).toContain(
      'Acceptance Criteria (ACs) must be created and verified before this spec can move to Done.',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Rubicon line — shape 3: browsing another tab → Are-you-sure + Yes/No', () => {
  it('forward browse while blocked → blocker summary + "Move this spec anyway?" + Yes + No', () => {
    tagAc(AC(3));
    tagAc(AC(13));
    render(
      <TransitionSentence
        {...baseProps({ viewedTab: 'build', openDecisionCount: 4, hasAcceptanceCriteria: false })}
      />,
    );
    expect(text()).toContain(
      '4 Decisions must be resolved and Acceptance Criteria (ACs) must be created before Build.',
    );
    // The summary already names the target — the question doesn't repeat it.
    expect(text()).toContain('Move this spec anyway?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No' })).toBeTruthy();
  });

  it('forward browse while clean → "Are you sure…?" + Yes/No, no blocker text', () => {
    tagAc(AC(13));
    render(<TransitionSentence {...baseProps({ viewedTab: 'build' })} />);
    expect(text()).toContain('Are you sure you want to move this spec to Build?');
    expect(text()).not.toContain('must be');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No' })).toBeTruthy();
  });

  it('backward browse → "move this spec back to" + Yes/No, never any blocker text (ac-4, ac-16)', () => {
    tagAc(AC(4));
    tagAc(AC(16));
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'verify', viewedTab: 'build', unverifiedAcCount: 7 })}
      />,
    );
    expect(text()).toContain('Do you want to move this spec back to Build?');
    expect(text()).not.toContain('must be verified');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No' })).toBeTruthy();
  });

  it('No fires onCancelBrowse and does NOT call the API (ac-16)', async () => {
    tagAc(AC(16));
    const user = userEvent.setup();
    const onCancelBrowse = vi.fn();
    render(<TransitionSentence {...baseProps({ viewedTab: 'build', onCancelBrowse })} />);
    await user.click(screen.getByRole('button', { name: 'No' }));
    expect(onCancelBrowse).toHaveBeenCalled();
    expect(updateDocStatus).not.toHaveBeenCalled();
  });
});

// spec-182 issue-1 (2026-06-05): the Rubicon is STATUS-ONLY for non-editors.
// Blocker statements render (they're the page's phase status); the transition
// questions never do, and a clean rubric renders nothing at all — the tab
// pill already carries the phase.
describe('Rubicon line — posture (i-1) and the Yes mutation', () => {
  const AC182_9 = 'mindset-prod/memex-building-itself/specs/spec-182/acs/ac-9';

  it('canTransition=false browsing forward with a clean rubric renders NOTHING — no question', () => {
    tagAc(AC182_9);
    render(<TransitionSentence {...baseProps({ viewedTab: 'build', canTransition: false })} />);
    expect(screen.queryByTestId('transition-sentence')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('canTransition=false on the current tab with a clean rubric renders NOTHING — no offer', () => {
    tagAc(AC182_9);
    render(<TransitionSentence {...baseProps({ canTransition: false })} />);
    expect(screen.queryByTestId('transition-sentence')).toBeNull();
  });

  it('canTransition=false on the current tab, blocked → the rubric condition, no buttons', () => {
    tagAc(AC182_9);
    render(
      <TransitionSentence
        {...baseProps({ openDecisionCount: 2, canTransition: false })}
      />,
    );
    expect(text()).toContain('2 Decisions');
    expect(text()).toContain('must be resolved');
    expect(text()).not.toContain('?');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('canTransition=false browsing forward, blocked → blocker summary only, no "Move anyway?"', () => {
    tagAc(AC182_9);
    render(
      <TransitionSentence
        {...baseProps({ viewedTab: 'build', openDecisionCount: 2, canTransition: false })}
      />,
    );
    expect(text()).toContain('2 Decisions');
    expect(text()).not.toContain('Move this spec anyway?');
    expect(text()).not.toContain('?');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('canTransition=false browsing backward renders NOTHING — no back-move question', () => {
    tagAc(AC182_9);
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'verify', viewedTab: 'build', canTransition: false })}
      />,
    );
    expect(screen.queryByTestId('transition-sentence')).toBeNull();
  });

  it('pressing Yes calls updateDocStatus(docId, target) immediately, no dialog (ac-6)', async () => {
    tagAc(AC(6));
    tagAc(AC(13));
    const user = userEvent.setup();
    const onTransitioned = vi.fn();
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'build', viewedTab: 'build', onTransitioned })}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-1', 'verify'));
    await waitFor(() => expect(onTransitioned).toHaveBeenCalledWith('verify'));
  });
});

// spec-182 dec-6 (amended 2026-06-05) — the in-slot "switch to Editing" nag
// was removed at the user's call; the header posture pill is the only switch
// affordance. This pins the absence so the nag doesn't quietly return.
describe('no switch-to-Editing nag (spec-182 dec-6, amended)', () => {
  const AC182 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-182/acs/ac-${n}`;

  it('a non-transitioning viewer sees a clean status line — no nag in any sentence shape', () => {
    tagAc(AC182(14));
    tagAc(AC182(6));
    // Clean offer shape — renders nothing at all for a non-editor
    // (spec-182 issue-1), so trivially no nag.
    const { unmount } = render(<TransitionSentence {...baseProps()} canTransition={false} />);
    expect(screen.queryByTestId('switch-to-editing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('transition-sentence')).toBeNull();
    unmount();

    // Blocked shape — the status line renders, nag-free.
    render(
      <TransitionSentence {...baseProps({ openDecisionCount: 2 })} canTransition={false} />,
    );
    expect(screen.queryByTestId('switch-to-editing')).not.toBeInTheDocument();
    expect(text()).not.toContain("You're reviewing");
  });
});
