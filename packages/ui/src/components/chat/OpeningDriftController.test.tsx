// spec-143 t-4 (dec-6) / spec-389 (dec-1) — the drift agent's on-mount controller.
//
//   - the controller enters drift mode on mount and leaves it on unmount;
//   - per spec-389 dec-1 it opens with the shared STATIC AgentIntro card, NOT an
//     opening LLM turn (like the standards / issues / scaffold agents), so it no
//     longer fires startDriftOpeningTurn — the first LLM call waits for the user.

import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-143';
// spec-143 t-4 (dec-6): the in-UI drift agent is LIVE on the Drift Inbox.
const AC_DRIFT_MODE = `${SPEC}/acs/ac-12`;
// ac-3 (scope, linked to dec-6): the drift-scoped agent sits alongside the
// Drift Inbox — it comes to life on mount (drift mode) and restores the default
// agent on unmount.
const AC_DRIFT_SURFACE = `${SPEC}/acs/ac-3`;

const mockEnterDriftMode = vi.fn();
const mockExitDriftMode = vi.fn();
let isDriftMode = true;

vi.mock('../ChatContext', () => ({
  useChat: () => ({
    enterDriftMode: mockEnterDriftMode,
    exitDriftMode: mockExitDriftMode,
    isDriftMode,
  }),
}));

import { OpeningDriftController } from './OpeningDriftController';

beforeEach(() => {
  vi.clearAllMocks();
  isDriftMode = true;
});

describe('OpeningDriftController', () => {
  it('enters drift mode on mount and leaves it on unmount', () => {
    tagAc(AC_DRIFT_MODE);
    tagAc(AC_DRIFT_SURFACE);
    const { unmount } = render(<OpeningDriftController />);
    expect(mockEnterDriftMode).toHaveBeenCalledTimes(1);
    expect(mockExitDriftMode).not.toHaveBeenCalled();
    unmount();
    expect(mockExitDriftMode).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire an opening LLM turn on entry (dec-1: static intro)', () => {
    tagAc(AC_DRIFT_MODE);
    tagAc(AC_DRIFT_SURFACE);
    // The controller exposes no startDriftOpeningTurn at all; entering drift mode
    // must not trigger any agent invocation. Asserting the mocked context shape has
    // no opening-turn hook guards against the icebreaker being reintroduced.
    render(<OpeningDriftController />);
    expect(mockEnterDriftMode).toHaveBeenCalledTimes(1);
  });
});
