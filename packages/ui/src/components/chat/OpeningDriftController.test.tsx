// spec-143 t-4 (dec-6) — the drift agent's on-mount controller + the drift-mode
// input gate.
//
//   - the controller enters drift mode on mount and fires the opening turn once,
//     with the scaffold-sourced drift seed (DRIFT_OPENING_TURN_SEED);
//   - it leaves drift mode on unmount;
//   - ChatPanel's input is LIVE on arrival in drift mode (canChat true) before
//     any context chip, so the agent "comes to life" on navigation.

import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { DRIFT_OPENING_TURN_SEED } from '@memex/shared';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-143';
// spec-143 t-4 (dec-6): the in-UI drift agent is LIVE on the Drift Inbox with a
// drift opening turn.
const AC_DRIFT_MODE = `${SPEC}/acs/ac-12`;
// ac-3 (scope, linked to dec-6): the drift-scoped agent sits alongside the
// Drift Inbox — it comes to life on mount (drift mode + opening turn) and
// restores the default agent on unmount.
const AC_DRIFT_SURFACE = `${SPEC}/acs/ac-3`;

const mockEnterDriftMode = vi.fn();
const mockExitDriftMode = vi.fn();
const mockStartDriftOpeningTurn = vi.fn();
let isDriftMode = true;

vi.mock('../ChatContext', () => ({
  useChat: () => ({
    enterDriftMode: mockEnterDriftMode,
    exitDriftMode: mockExitDriftMode,
    startDriftOpeningTurn: mockStartDriftOpeningTurn,
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

  it('fires the drift opening turn ONCE with the scaffold-sourced seed', async () => {
    tagAc(AC_DRIFT_MODE);
    tagAc(AC_DRIFT_SURFACE);
    render(<OpeningDriftController />);
    await waitFor(() =>
      expect(mockStartDriftOpeningTurn).toHaveBeenCalledTimes(1),
    );
    expect(mockStartDriftOpeningTurn).toHaveBeenCalledWith(DRIFT_OPENING_TURN_SEED);
  });

  it('does not fire the opening turn until drift mode is active', () => {
    tagAc(AC_DRIFT_MODE);
    isDriftMode = false;
    render(<OpeningDriftController />);
    // enterDriftMode is still called (mount), but the fire effect short-circuits
    // until isDriftMode flips true.
    expect(mockEnterDriftMode).toHaveBeenCalledTimes(1);
    expect(mockStartDriftOpeningTurn).not.toHaveBeenCalled();
  });
});
