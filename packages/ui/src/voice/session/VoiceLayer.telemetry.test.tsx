import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = 'mindset-prod/memex-building-itself/specs/spec-338/acs';

// A mutable fake voice session the test drives through the state machine; the
// VoiceLayer effect observes status transitions at the shell and fires telemetry.
let sessionStatus = 'inactive';
vi.mock('@memex/guide-sdk', () => ({
  useVoiceSession: () => ({ status: sessionStatus, error: null }),
  VoiceIcon: () => null,
  VoiceSessionPill: () => null,
  Specky: () => null,
}));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/ns/mx/specs' }) }));
// Spread the REAL @memex/shared and override only resolveScreenKey — a full-module
// replacement would strip whatever the AC-emit setup imports from it and silently
// kill this file's tagAc emissions (the reason ac-9/ac-11/ac-4 didn't land first time).
vi.mock('@memex/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveScreenKey: () => 'specs' };
});

const track = vi.fn();
vi.mock('../../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track, optedOut: false, setOptOut: vi.fn() }),
}));

import { VoiceLayer } from './VoiceLayer';

describe('VoiceLayer — voice telemetry transitions', () => {
  beforeEach(() => {
    track.mockClear();
    sessionStatus = 'inactive';
  });

  it('fires icon_shown once on mount when the entry icon is visible', () => {
    tagAc(`${AC}/ac-9`); // voice.icon_shown once per mount
    tagAc(`${AC}/ac-4`); // scope: voice funnel — the entry icon is presented
    render(<VoiceLayer />);
    const iconShown = track.mock.calls.filter((c) => c[0] === 'voice.icon_shown');
    expect(iconShown).toHaveLength(1);
    expect(iconShown[0][1]).toEqual({ surface: 'icon' });
  });

  it('grant path: requesting → active fires session_started + mic granted', () => {
    tagAc(`${AC}/ac-11`); // session_started/ended + mic_permission from transitions
    tagAc(`${AC}/ac-4`);
    sessionStatus = 'inactive';
    const { rerender } = render(<VoiceLayer />);
    track.mockClear();

    sessionStatus = 'requesting_permission';
    rerender(<VoiceLayer />);
    sessionStatus = 'active';
    rerender(<VoiceLayer />);

    expect(track).toHaveBeenCalledWith('voice.session_started');
    expect(track).toHaveBeenCalledWith('voice.mic_permission_result', { result: 'granted' });
  });

  it('denied path: requesting → permission_denied fires mic denied (no session_started)', () => {
    tagAc(`${AC}/ac-11`);
    tagAc(`${AC}/ac-4`);
    sessionStatus = 'requesting_permission';
    const { rerender } = render(<VoiceLayer />);
    track.mockClear();

    sessionStatus = 'permission_denied';
    rerender(<VoiceLayer />);

    expect(track).toHaveBeenCalledWith('voice.mic_permission_result', { result: 'denied' });
    expect(track).not.toHaveBeenCalledWith('voice.session_started');
  });

  it('active → inactive fires session_ended with a numeric durationMs', () => {
    tagAc(`${AC}/ac-11`);
    tagAc(`${AC}/ac-4`);
    sessionStatus = 'active';
    const { rerender } = render(<VoiceLayer />);
    track.mockClear();

    sessionStatus = 'inactive';
    rerender(<VoiceLayer />);

    const ended = track.mock.calls.find((c) => c[0] === 'voice.session_ended');
    expect(ended).toBeTruthy();
    expect(typeof (ended![1] as { durationMs: number }).durationMs).toBe('number');
  });
});
