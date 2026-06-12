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
const S258 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-258/acs/ac-${n}`;

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
    currentPhase: 'specify' as SpecStatus,
    viewedTab: 'specify' as SpecStatus,
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

  it('draft → offers specify (draft is never gated)', () => {
    tagAc(AC(3));
    tagAc(AC(13));
    render(
      <TransitionSentence
        {...baseProps({
          currentPhase: 'draft',
          viewedTab: 'specify',
          totalDecisionCount: 0,
          hasAcceptanceCriteria: false,
        })}
      />,
    );
    expect(text()).toContain('Do you wish to move this spec to Specify?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'No' })).toBeNull();
  });

  it('specify (clean) → "Do you wish to move this spec to Build?" + Yes', () => {
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

// spec-258/dec-5 amended shape 2: the blocked current tab still states the exact
// rubric condition (spec-159 ac-13), and now an EDITOR additionally gets a "Move
// this spec to {Phase} anyway?" override [Yes]. A non-editor still sees the
// blocker statement alone (spec-182/dec-2). The blocker-text assertions below
// keep ac-13 covered; the override assertions cover spec-258 ac-9 / ac-8.
describe('Rubicon line — shape 2: current tab, blocked → exact status + editor override (spec-258)', () => {
  it('specify with no decisions and no ACs → combined summary + editor override', () => {
    tagAc(AC(3));
    tagAc(AC(13));
    tagAc(S258(9));
    render(
      <TransitionSentence
        {...baseProps({ totalDecisionCount: 0, hasAcceptanceCriteria: false })}
      />,
    );
    expect(text()).toContain(
      'Decisions and Acceptance Criteria (ACs) must be created before this spec can move to Build.',
    );
    // dec-5: the editor override appears on the blocked current tab.
    expect(text()).toContain('Move this spec to Build anyway?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'No' })).toBeNull();
  });

  it('specify with open decisions and ACs present → decisions-only summary + override', () => {
    tagAc(AC(13));
    tagAc(S258(9));
    render(<TransitionSentence {...baseProps({ openDecisionCount: 4 })} />);
    expect(text()).toContain('4 Decisions must be resolved before this spec can move to Build.');
    expect(text()).toContain('Move this spec to Build anyway?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
  });

  it('singular grammar: 1 open decision → "1 Decision must be resolved"', () => {
    tagAc(AC(13));
    render(<TransitionSentence {...baseProps({ openDecisionCount: 1 })} />);
    expect(text()).toContain('1 Decision must be resolved before this spec can move to Build.');
  });

  it('build with open tasks → "{N} Tasks must be completed…" + override to Verify', () => {
    tagAc(AC(13));
    tagAc(S258(9));
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'build', viewedTab: 'build', openTaskCount: 2 })}
      />,
    );
    expect(text()).toContain('2 Tasks must be completed before this spec can move to Verify.');
    expect(text()).toContain('Move this spec to Verify anyway?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
  });

  it('verify with unverified ACs → "{N} Acceptance Criteria (ACs) must be verified…" + override to Done', () => {
    tagAc(AC(13));
    tagAc(S258(9));
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'verify', viewedTab: 'verify', unverifiedAcCount: 3 })}
      />,
    );
    expect(text()).toContain('3 Acceptance Criteria (ACs) must be verified before this spec can move to Done.');
    expect(text()).toContain('Move this spec to Done anyway?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
  });

  it('build with ZERO tasks is blocked — an empty build still offers the editor override', () => {
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
    expect(text()).toContain('Move this spec to Verify anyway?');
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

// spec-258/dec-5 — the editor override on a blocked current tab, end to end. The
// override is phase-generic, so it must work on every forward axis; pressing its
// [Yes] forces the move through the existing updateDocStatus(target) call (the
// move the server already accepts — soft gates, spec-12/dec-6). A non-editor's
// blocked current tab stays status-only (spec-182/dec-2). Covers ac-9 / ac-8.
describe('Rubicon line — editor override on a blocked current tab (spec-258 dec-5)', () => {
  it('verify→done: blocked editor presses "Move … anyway?" → updateDocStatus(doc, "done") (the issue-3 close)', async () => {
    tagAc(S258(9));
    tagAc(S258(8));
    const user = userEvent.setup();
    const onTransitioned = vi.fn();
    render(
      <TransitionSentence
        {...baseProps({
          currentPhase: 'verify',
          viewedTab: 'verify',
          unverifiedAcCount: 3,
          onTransitioned,
        })}
      />,
    );
    expect(text()).toContain('Move this spec to Done anyway?');
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-1', 'done'));
    await waitFor(() => expect(onTransitioned).toHaveBeenCalledWith('done'));
  });

  it('build→verify: blocked editor override forces the move via updateDocStatus(doc, "verify")', async () => {
    tagAc(S258(9));
    const user = userEvent.setup();
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'build', viewedTab: 'build', openTaskCount: 2 })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-1', 'verify'));
  });

  it('specify→build: blocked editor override forces the move via updateDocStatus(doc, "build")', async () => {
    tagAc(S258(9));
    const user = userEvent.setup();
    render(<TransitionSentence {...baseProps({ openDecisionCount: 4 })} />);
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-1', 'build'));
  });

  it('non-editor blocked current tab stays status-only on every axis — no override (ac-8, spec-182/dec-2)', () => {
    tagAc(S258(8));
    const axes = [
      { props: { openDecisionCount: 4 }, phase: 'Build' },
      { props: { currentPhase: 'build' as SpecStatus, viewedTab: 'build' as SpecStatus, openTaskCount: 2 }, phase: 'Verify' },
      {
        props: {
          currentPhase: 'verify' as SpecStatus,
          viewedTab: 'verify' as SpecStatus,
          unverifiedAcCount: 3,
        },
        phase: 'Done',
      },
    ];
    for (const { props, phase } of axes) {
      const { unmount } = render(
        <TransitionSentence {...baseProps({ ...props, canTransition: false })} />,
      );
      expect(text()).toContain('must be');
      expect(text()).not.toContain(`Move this spec to ${phase} anyway?`);
      expect(screen.queryByRole('button')).toBeNull();
      unmount();
    }
  });
});
