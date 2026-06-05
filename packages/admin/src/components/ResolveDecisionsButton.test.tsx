import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResolveDecisionsButton } from './ResolveDecisionsButton';
import type { SpecStatus } from '../api/types';

const mockSendMessage = vi.fn();

vi.mock('./ChatContext', () => ({
  useChat: () => ({ sendMessage: mockSendMessage }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function renderResolve(phase: SpecStatus, openDecisionCount: number) {
  return render(
    <ResolveDecisionsButton phase={phase} openDecisionCount={openDecisionCount} />,
  );
}

describe('ResolveDecisionsButton — visibility', () => {
  it('hidden in `done` even with open decisions', () => {
    renderResolve('done', 3);
    expect(
      screen.queryByRole('button', { name: /Resolve Decisions/i }),
    ).not.toBeInTheDocument();
  });

  it('hidden when openDecisionCount is 0', () => {
    renderResolve('build', 0);
    expect(
      screen.queryByRole('button', { name: /Resolve Decisions?/i }),
    ).not.toBeInTheDocument();
  });

  it('visible in draft / plan / build / verify when decisions exist', () => {
    for (const phase of ['draft', 'plan', 'build', 'verify'] as const) {
      const { unmount } = renderResolve(phase, 1);
      expect(
        screen.getByRole('button', { name: /Resolve Decision/i }),
      ).toBeInTheDocument();
      unmount();
    }
  });
});

describe('ResolveDecisionsButton — labels', () => {
  it('uses singular "Decision" when there is one open', () => {
    renderResolve('plan', 1);
    expect(screen.getByRole('button')).toHaveTextContent('Resolve Decision (1)');
  });

  it('uses plural "Decisions" for two or more', () => {
    renderResolve('plan', 4);
    expect(screen.getByRole('button')).toHaveTextContent('Resolve Decisions (4)');
  });

  it('aria-label spells out the count', () => {
    renderResolve('build', 7);
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'Resolve decisions (7 open)',
    );
  });
});

describe('ResolveDecisionsButton — click behavior', () => {
  it('seeds the chat with the decision-walkthrough prompt', async () => {
    const user = userEvent.setup();
    renderResolve('plan', 2);

    await user.click(screen.getByRole('button', { name: /Resolve Decisions/i }));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringMatching(/walk through the open decisions/i),
    );
  });
});
