import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { PhaseTabBar } from './PhaseTabBar';
import { TransitionSentence } from './TransitionSentence';
import { phaseDisplayName } from '../utils/phaseDisplay';
import type { SpecStatus } from '../api/types';

// spec-164 dec-1 — the phase display-name layer. The planning phase presents
// to users as "Specify" everywhere a phase name is printed, while the enum
// value, the API payloads, and data-tab attributes keep `plan`.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-164/acs/ac-${n}`;

const updateDocStatus = vi.fn();
vi.mock('../api/client', () => ({
  updateDocStatus: (...a: unknown[]) => updateDocStatus(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  updateDocStatus.mockResolvedValue(undefined);
});

describe('phaseDisplayName — the shared map (ac-11)', () => {
  it('maps plan → "Specify" and the other phases to their capitalised names', () => {
    tagAc(AC(11));
    tagAc('mindset-prod/memex-building-itself/specs/spec-164/acs/ac-1');
    expect(phaseDisplayName('plan')).toBe('Specify');
    expect(phaseDisplayName('draft')).toBe('Draft');
    expect(phaseDisplayName('build')).toBe('Build');
    expect(phaseDisplayName('verify')).toBe('Verify');
    expect(phaseDisplayName('done')).toBe('Done');
  });

  it('PhaseTabBar renders "Specify" from the map while data-tab keeps `plan`', () => {
    tagAc(AC(11));
    render(
      <PhaseTabBar currentPhase={'plan' as SpecStatus} selectedTab="plan" onSelect={() => {}} />,
    );
    const planTab = screen.getByRole('tab', { name: /Specify/ });
    expect(planTab).toHaveAttribute('data-tab', 'plan');
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
        viewedTab={'plan' as SpecStatus}
      />,
    );
    expect(screen.getByTestId('transition-sentence').textContent).toContain(
      'Do you wish to move this spec to Specify?',
    );
  });

  it('pressing Yes still sends the `plan` enum value to updateDocStatus', async () => {
    tagAc(AC(12));
    render(
      <TransitionSentence
        doc={{ id: 'doc-1' }}
        currentPhase={'draft' as SpecStatus}
        viewedTab={'plan' as SpecStatus}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-1', 'plan'));
  });

  it('blocker lines name the display target ("…before this spec can move to Build.")', () => {
    tagAc(AC(12));
    render(
      <TransitionSentence
        doc={{ id: 'doc-1' }}
        currentPhase={'plan' as SpecStatus}
        viewedTab={'plan' as SpecStatus}
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
