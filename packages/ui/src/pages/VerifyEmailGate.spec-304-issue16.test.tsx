// @vitest-environment jsdom
// spec-304 issue-16 / ac-76: the desktop VerifyEmailGate must clear promptly once
// the email is verified OUTSIDE the webview (the link opens in the system browser),
// without a manual reload and without relying on an incidental SSE reconnect.
// The fix is client-side: re-check the session (the existing refreshSession()) on
// window focus / tab visibility, plus a gentle poll while the gate is mounted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-76';

// Hoisted so the (hoisted) vi.mock factory below can close over the same spy we
// assert on.
const { refreshSessionMock } = vi.hoisted(() => ({ refreshSessionMock: vi.fn() }));

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    session: { user: { email: 'new@example.com' } },
    token: 'tok',
    logout: vi.fn(),
    refreshSession: refreshSessionMock,
  }),
}));

vi.mock('../api/client', () => ({
  resendVerificationApi: vi.fn(),
  AuthApiError: class AuthApiError extends Error {
    constructor(public status: number, public reason: string, message: string) {
      super(message);
    }
  },
}));

vi.mock('../components/Logo', () => ({ Logo: () => null }));

const { VerifyEmailGate } = await import('./VerifyEmailGate');

describe('VerifyEmailGate — clears on return, no manual reload (spec-304 issue-16, ac-76)', () => {
  beforeEach(() => {
    refreshSessionMock.mockReset();
    refreshSessionMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('does not re-check on mount, but re-checks on window focus (ac-76)', async () => {
    tagAc(AC);
    await act(async () => {
      render(<VerifyEmailGate />);
    });
    expect(refreshSessionMock).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
  });

  it('re-checks when the tab becomes visible (ac-76)', async () => {
    tagAc(AC);
    await act(async () => {
      render(<VerifyEmailGate />);
    });
    // jsdom's default document.visibilityState is 'visible'.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
  });

  it('polls the session while the gate is mounted (ac-76)', async () => {
    tagAc(AC);
    vi.useFakeTimers();
    try {
      render(<VerifyEmailGate />);
      expect(refreshSessionMock).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(8000);
      });
      expect(refreshSessionMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(8000);
      });
      expect(refreshSessionMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears the poll + listeners down on unmount (ac-76)', async () => {
    tagAc(AC);
    vi.useFakeTimers();
    try {
      const { unmount } = render(<VerifyEmailGate />);
      unmount();
      await act(async () => {
        vi.advanceTimersByTime(24000);
      });
      window.dispatchEvent(new Event('focus'));
      expect(refreshSessionMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
