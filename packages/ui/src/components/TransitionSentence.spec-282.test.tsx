import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { TransitionSentence } from './TransitionSentence';
import type { SpecStatus } from '../api/types';

// spec-282 t-2 / dec-4 — trim the Rubicon's standing advance offer to browse-only.
//
//   ac-5  : on the current specify/build/verify tab no advance question/button
//           renders — status-only in both the ready and the blocked state.
//   ac-6  : the advance affordance ([Yes]/[No]) appears ONLY when browsing a
//           non-current phase tab; the editor's force-forward path is reachable
//           there (spec-258/dec-5 preserved by relocation).
//   ac-11 : the implementation shape — draft keeps its publish offer; the
//           current tab is status-only; browsing forward shows the confirm.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-282/acs/ac-${n}`;

const updateDocStatus = vi.fn();
vi.mock('../api/client', () => ({
  updateDocStatus: (...a: unknown[]) => updateDocStatus(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  updateDocStatus.mockResolvedValue(undefined);
});

const DOC = { id: 'doc-1' };

function baseProps(overrides: Partial<React.ComponentProps<typeof TransitionSentence>> = {}) {
  return {
    doc: DOC,
    currentPhase: 'specify' as SpecStatus,
    viewedTab: 'specify' as SpecStatus,
    canTransition: true,
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

describe('spec-282 ac-5/ac-11 — the current phase tab carries no advance offer', () => {
  // Ready state: every current-phase tab renders nothing — no question, no button.
  for (const phase of ['specify', 'build', 'verify'] as const) {
    it(`${phase} ready, current tab → nothing renders (no offer, no button)`, () => {
      tagAc(AC(5));
      tagAc(AC(11));
      render(<TransitionSentence {...baseProps({ currentPhase: phase, viewedTab: phase })} />);
      expect(screen.queryByTestId('transition-sentence')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
    });
  }

  // Blocked state: the rubric statement renders, but there is NO question and NO
  // button — status-only — for editors and non-editors alike.
  for (const canTransition of [true, false]) {
    it(`specify blocked, current tab (canTransition=${canTransition}) → blocker text only, no button`, () => {
      tagAc(AC(5));
      tagAc(AC(11));
      render(
        <TransitionSentence
          {...baseProps({ openDecisionCount: 3, canTransition })}
        />,
      );
      expect(text()).toContain('3 Decisions must be resolved before this spec can move to Build.');
      expect(text()).not.toContain('?');
      expect(screen.queryByRole('button')).toBeNull();
    });
  }

  it('build blocked, current tab (editor) → tasks statement only, no "anyway?" button', () => {
    tagAc(AC(5));
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'build', viewedTab: 'build', openTaskCount: 2 })}
      />,
    );
    expect(text()).toContain('2 Tasks must be completed before this spec can move to Verify.');
    expect(text()).not.toContain('anyway?');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('spec-282 ac-11 — draft keeps the publish offer', () => {
  it('draft (editor) → "Do you wish to move this spec to Specify?" + [Yes]', () => {
    tagAc(AC(11));
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

  it('draft (non-editor) → nothing to act on, renders nothing', () => {
    tagAc(AC(11));
    render(
      <TransitionSentence
        {...baseProps({
          currentPhase: 'draft',
          viewedTab: 'specify',
          canTransition: false,
          totalDecisionCount: 0,
          hasAcceptanceCriteria: false,
        })}
      />,
    );
    expect(screen.queryByTestId('transition-sentence')).toBeNull();
  });
});

describe('spec-282 ac-6/ac-11 — the advance affordance lives on the browse-forward confirm', () => {
  it('browsing the forward phase tab (clean) → "Are you sure…?" + [Yes] [No]', () => {
    tagAc(AC(6));
    tagAc(AC(11));
    render(<TransitionSentence {...baseProps({ currentPhase: 'build', viewedTab: 'verify' })} />);
    expect(text()).toContain('Are you sure you want to move this spec to Verify?');
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No' })).toBeTruthy();
  });

  it('editor force-forward: browse the forward tab while blocked → "Move this spec anyway?" forces the move', async () => {
    tagAc(AC(6));
    const user = userEvent.setup();
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'build', viewedTab: 'verify', openTaskCount: 2 })}
      />,
    );
    expect(text()).toContain('Move this spec anyway?');
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-1', 'verify'));
  });

  it('the [No] on the browse confirm returns to the current tab and never mutates', async () => {
    tagAc(AC(6));
    const user = userEvent.setup();
    const onCancelBrowse = vi.fn();
    render(
      <TransitionSentence
        {...baseProps({ currentPhase: 'build', viewedTab: 'verify', onCancelBrowse })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'No' }));
    expect(onCancelBrowse).toHaveBeenCalled();
    expect(updateDocStatus).not.toHaveBeenCalled();
  });
});
