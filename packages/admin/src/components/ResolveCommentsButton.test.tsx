import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResolveCommentsButton } from './ResolveCommentsButton';
import type { SpecStatus } from '../api/types';

const mockSendMessage = vi.fn();

vi.mock('./ChatContext', () => ({
  useChat: () => ({ sendMessage: mockSendMessage }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function renderResolve(phase: SpecStatus, openCommentCount: number) {
  return render(
    <ResolveCommentsButton phase={phase} openCommentCount={openCommentCount} />,
  );
}

describe('ResolveCommentsButton — visibility', () => {
  it('hidden in `done` even when there are open comments', () => {
    renderResolve('done', 7);
    expect(
      screen.queryByRole('button', { name: /Resolve comments/i }),
    ).not.toBeInTheDocument();
  });

  it('hidden when openCommentCount is 0', () => {
    renderResolve('build', 0);
    expect(
      screen.queryByRole('button', { name: /Resolve comments/i }),
    ).not.toBeInTheDocument();
  });

  it('visible in `draft` (deliberate asymmetry with RefreshSpecButton)', () => {
    renderResolve('draft', 3);
    // The visible label includes the count; aria-label spells "open" out for SR users.
    expect(
      screen.getByRole('button', { name: 'Resolve comments (3 open)' }),
    ).toBeInTheDocument();
  });

  it('visible in `plan` / `build` / `verify` when comments exist', () => {
    for (const phase of ['plan', 'build', 'verify'] as const) {
      const { unmount } = renderResolve(phase, 1);
      expect(
        screen.getByRole('button', { name: /Resolve comments \(1 open\)/i }),
      ).toBeInTheDocument();
      unmount();
    }
  });
});

describe('ResolveCommentsButton — counter', () => {
  it('shows the live count in the visible label', () => {
    const { rerender } = render(
      <ResolveCommentsButton phase="build" openCommentCount={3} />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Resolve Comments (3)');

    // Simulate the SSE-driven count update from the parent.
    rerender(<ResolveCommentsButton phase="build" openCommentCount={5} />);
    expect(screen.getByRole('button')).toHaveTextContent('Resolve Comments (5)');

    // Drop to zero — the button hides.
    rerender(<ResolveCommentsButton phase="build" openCommentCount={0} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('aria-label spells out the count for screen readers', () => {
    renderResolve('build', 12);
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'Resolve comments (12 open)',
    );
  });
});

describe('ResolveCommentsButton — click behavior', () => {
  it('seeds the chat with the comment-walkthrough prompt', async () => {
    const user = userEvent.setup();
    renderResolve('build', 4);

    await user.click(screen.getByRole('button', { name: /Resolve comments/i }));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Walk through the open comments/i),
    );
  });
});
