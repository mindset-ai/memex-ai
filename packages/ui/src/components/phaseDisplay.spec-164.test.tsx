import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { PhaseTabBar } from './PhaseTabBar';
import { TransitionSentence } from './TransitionSentence';
import { phaseDisplayName } from '../utils/phaseDisplay';
import type { SpecStatus } from '../api/types';

// spec-181 — the phase rename collapsed the spec-164 display-name shim. The
// second phase value is now `specify` end-to-end (enum value, API payloads,
// data-tab attributes), so "Specify" falls straight out of capitalising the
// enum value. The spec-164 ACs still hold — the UI prints "Specify" everywhere
// a phase name is rendered — but the value carried underneath is now `specify`,
// not `plan`. These tests assert that NEW reality (see also the spec-181 ac-4
// test below, which pins that the shim no longer carries a plan→"Specify" entry).

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-164/acs/ac-${n}`;

const updateDocStatus = vi.fn();
vi.mock('../api/client', () => ({
  updateDocStatus: (...a: unknown[]) => updateDocStatus(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  updateDocStatus.mockResolvedValue(undefined);
});

describe('phaseDisplayName — a plain capitaliser (spec-181)', () => {
  it('renders "Specify" from the `specify` enum value and capitalises every phase', () => {
    tagAc(AC(11));
    tagAc('mindset-prod/memex-building-itself/specs/spec-164/acs/ac-1');
    // The former plan→"Specify" map entry is gone — "Specify" is just the
    // capitalised enum value now.
    expect(phaseDisplayName('specify')).toBe('Specify');
    expect(phaseDisplayName('draft')).toBe('Draft');
    expect(phaseDisplayName('build')).toBe('Build');
    expect(phaseDisplayName('verify')).toBe('Verify');
    expect(phaseDisplayName('done')).toBe('Done');
    // The collapsed shim no longer special-cases `plan`; a stale `plan` value
    // would now capitalise to "Plan", proving there is no plan→"Specify" entry.
    expect(phaseDisplayName('plan')).toBe('Plan');
  });

  it('PhaseTabBar renders "Specify" and data-tab is the `specify` enum value', () => {
    tagAc(AC(11));
    render(
      <PhaseTabBar
        currentPhase={'specify' as SpecStatus}
        selectedTab="specify"
        onSelect={() => {}}
      />,
    );
    const specifyTab = screen.getByRole('tab', { name: /Specify/ });
    expect(specifyTab).toHaveAttribute('data-tab', 'specify');
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
  });
});

describe('TransitionSentence renders display names, sends enum values (ac-12)', () => {
  it('draft on its home tab asks "Do you wish to move this spec to Specify?"', () => {
    tagAc(AC(12));
    render(
      <TransitionSentence
        doc={{ id: 'doc-1' }}
        currentPhase={'draft' as SpecStatus}
        viewedTab={'specify' as SpecStatus}
      />,
    );
    expect(screen.getByTestId('transition-sentence').textContent).toContain(
      'Do you wish to move this spec to Specify?',
    );
  });

  it('pressing Yes sends the `specify` enum value to updateDocStatus', async () => {
    tagAc(AC(12));
    render(
      <TransitionSentence
        doc={{ id: 'doc-1' }}
        currentPhase={'draft' as SpecStatus}
        viewedTab={'specify' as SpecStatus}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-1', 'specify'));
  });

  it('blocker lines name the display target ("…before this spec can move to Build.")', () => {
    tagAc(AC(12));
    render(
      <TransitionSentence
        doc={{ id: 'doc-1' }}
        currentPhase={'specify' as SpecStatus}
        viewedTab={'specify' as SpecStatus}
        totalDecisionCount={1}
        openDecisionCount={1}
        hasAcceptanceCriteria
      />,
    );
    expect(screen.getByTestId('transition-sentence').textContent).toContain(
      '1 Decision must be resolved before this spec can move to Build.',
    );
  });
});
