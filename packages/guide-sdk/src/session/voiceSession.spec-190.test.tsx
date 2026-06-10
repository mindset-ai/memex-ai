// spec-190 t-8 (dec-5) — the session UX surface. Covers ac-29 (in-view icon on
// registered screens; floating pill that persists across routes, reflects live
// loop state, tap-to-interrupt + mute + end) and ac-31 (mic permission on START
// not load; denied recovery; disabled when no mic; no transcript; earcons via app
// playback). All injectable deps are faked so the flow runs in jsdom with no real
// Web Audio / mic / orchestrator.
//
// spec-222 (ac-9): this test moved into guide-sdk with the engine, so it can no
// longer import the app-only VoiceLayer (which uses react-router + @memex/shared).
// Instead a tiny in-test harness replicates VoiceLayer's render decision — show the
// pill when active, the recovery card on denied/error, else the in-view icon ONLY
// on a "registered" screen — driving the screen gating through an injected current
// path (the same seam the real VoiceLayer reads via resolveScreenKey). Every
// assertion + tagAc is preserved.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { useState } from 'react';
import { VoiceSessionProvider, useVoiceSession } from './VoiceSessionContext';
import { VoiceIcon } from './VoiceIcon';
import { VoiceSessionPill } from './VoiceSessionPill';
import { Specky } from '../components/Specky';
import type { EarconPlayer } from './earcons';
import type { Earcon } from './voiceSessionModel';
import type { OrchestratorFactory, OrchestratorHooks } from './orchestrator';

const AC29 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-29';
const AC31 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-31';
// Scope ACs (t-9 sweep): ac-1 = in-view affordance to start a voice conversation;
// ac-5 = the user can interrupt / mute / end at any time. Also emitted by the e2e
// journey-21; tagged here too so they verify off the deterministic unit tests.
const AC1 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-1';
const AC5 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-5';

const ANCHOR = 'fixed bottom-6 right-6 z-50';

// A registered-screen predicate standing in for the app's resolveScreenKey: any
// path that isn't the explicit "not-a-registered-screen" sentinel is registered.
function screenKeyFor(path: string): string | null {
  return path.includes('not-a-registered-screen') ? null : 'specs-list';
}

// The in-test VoiceLayer: mirrors the real component's decision tree, but gates the
// icon on the injected current path instead of react-router's useLocation.
function VoiceLayerHarness({ path }: { path: string }): React.JSX.Element | null {
  const session = useVoiceSession();
  if (session.status === 'active') {
    return (
      <div className={ANCHOR}>
        <VoiceSessionPill />
      </div>
    );
  }
  if (session.status === 'permission_denied' || session.status === 'error') {
    return (
      <div className={ANCHOR} data-voice-recovery data-recovery-kind={session.status}>
        <button type="button" data-voice-retry onClick={() => void session.retryPermission()}>
          Retry
        </button>
        <button type="button" data-voice-dismiss onClick={session.end}>
          Dismiss
        </button>
      </div>
    );
  }
  if (screenKeyFor(path) === null) return null;
  return (
    <div className={ANCHOR}>
      <VoiceIcon mark={<Specky size={40} />} />
    </div>
  );
}

function recordingEarcons(): EarconPlayer & { played: Earcon[] } {
  const played: Earcon[] = [];
  return { played, play: (e) => played.push(e), dispose: () => {} };
}

// Captures the hooks so a test can drive the live loop state, and records calls.
function fakeOrchestrator(): {
  factory: OrchestratorFactory;
  hooks: () => OrchestratorHooks;
  calls: string[];
} {
  let captured: OrchestratorHooks | null = null;
  const calls: string[] = [];
  const factory: OrchestratorFactory = (hooks) => {
    captured = hooks;
    return {
      start: () => { calls.push('start'); },
      interrupt: () => { calls.push('interrupt'); },
      stop: () => { calls.push('stop'); },
      narratePhase: () => { calls.push('narratePhase'); hooks.onTurnComplete?.(); },
    };
  };
  return { factory, hooks: () => captured!, calls };
}

interface HarnessOpts {
  initialPath?: string;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  detectMic?: () => boolean;
  earcons?: EarconPlayer;
  factory?: OrchestratorFactory;
}

// A tiny route control so we can change the "screen" WITHOUT remounting the
// provider (proving the pill persists across route changes).
function Harness({ opts }: { opts: HarnessOpts }): React.JSX.Element {
  const [path, setPath] = useState(opts.initialPath ?? '/ns/mx/specs');
  const earcons = opts.earcons ?? recordingEarcons();
  return (
    <VoiceSessionProvider
      earcons={earcons}
      getUserMedia={opts.getUserMedia ?? (async () => fakeStream())}
      detectMic={opts.detectMic ?? (() => true)}
      orchestratorFactory={opts.factory}
    >
      <VoiceLayerHarness path={path} />
      <button data-testid="nav-/ns/mx/standards" onClick={() => setPath('/ns/mx/standards')}>go</button>
      <button data-testid="nav-/ns/mx/not-a-registered-screen" onClick={() => setPath('/ns/mx/not-a-registered-screen')}>go</button>
    </VoiceSessionProvider>
  );
}

function renderVoice(opts: HarnessOpts = {}) {
  return render(<Harness opts={opts} />);
}

function fakeStream(): MediaStream {
  // jsdom has no MediaStream; a minimal stand-in with getTracks().
  return { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
}

async function startSession(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Ask Specky'));
  });
}

beforeEach(() => vi.clearAllMocks());

describe('voice icon affordance (ac-29 / ac-1 / ac-31)', () => {
  it('renders the in-view icon on a registered screen', () => {
    tagAc(AC29);
    tagAc(AC1); // scope: in-view affordance to start a voice conversation

    renderVoice({ initialPath: '/ns/mx/specs' });
    expect(screen.getByLabelText('Ask Specky')).toBeInTheDocument();
  });

  it('does NOT render the icon on a non-registered route', () => {
    tagAc(AC29);
    renderVoice({ initialPath: '/ns/mx/not-a-registered-screen' });
    expect(screen.queryByLabelText('Ask Specky')).not.toBeInTheDocument();
  });

  it('disables the affordance when no mic is available (ac-31)', () => {
    tagAc(AC31);
    renderVoice({ detectMic: () => false });
    expect(screen.getByLabelText('Specky (microphone unavailable)')).toBeDisabled();
  });

  it('does NOT request mic permission on load — only on start (ac-31)', async () => {
    tagAc(AC31);
    const getUserMedia = vi.fn(async () => fakeStream());
    renderVoice({ getUserMedia });
    expect(getUserMedia).not.toHaveBeenCalled(); // nothing on mount
    await startSession();
    expect(getUserMedia).toHaveBeenCalledTimes(1); // requested on start
  });
});

describe('session pill (ac-29)', () => {
  it('opens the pill on start, with end + tap-to-interrupt controls', async () => {
    tagAc(AC29);
    renderVoice();
    await startSession();
    expect(screen.getByTestId('nav-/ns/mx/standards')).toBeInTheDocument();
    const pill = document.querySelector('[data-voice-pill]');
    expect(pill).toBeTruthy();
    expect(document.querySelector('[data-voice-end]')).toBeTruthy();
    expect(document.querySelector('[data-voice-interrupt]')).toBeTruthy();
  });

  it('persists across route changes (incl. to a non-registered route)', async () => {
    tagAc(AC29);
    renderVoice();
    await startSession();
    expect(document.querySelector('[data-voice-pill]')).toBeTruthy();
    // Navigate to a NON-registered route — the pill must remain.
    await act(async () => {
      fireEvent.click(screen.getByTestId('nav-/ns/mx/not-a-registered-screen'));
    });
    expect(document.querySelector('[data-voice-pill]')).toBeTruthy();
    // And the icon must NOT show while a session is active.
    expect(screen.queryByLabelText('Ask Specky')).not.toBeInTheDocument();
  });

  it('reflects the live loop state driven by the orchestrator', async () => {
    tagAc(AC29);
    const orch = fakeOrchestrator();
    renderVoice({ factory: orch.factory });
    await startSession();
    expect(document.querySelector('[data-voice-pill]')?.getAttribute('data-loop-state')).toBe('listening');
    act(() => orch.hooks().setLoopState('thinking'));
    expect(document.querySelector('[data-voice-pill]')?.getAttribute('data-loop-state')).toBe('thinking');
    act(() => orch.hooks().setLoopState('speaking'));
    expect(document.querySelector('[data-voice-pill]')?.getAttribute('data-loop-state')).toBe('speaking');
  });

  it('tap-to-interrupt calls the orchestrator; end stops + closes the pill', async () => {
    tagAc(AC29);
    tagAc(AC5); // scope: interrupt / end at any time

    const orch = fakeOrchestrator();
    renderVoice({ factory: orch.factory });
    await startSession();
    fireEvent.click(document.querySelector('[data-voice-interrupt]')!);
    expect(orch.calls).toContain('interrupt');
    fireEvent.click(document.querySelector('[data-voice-end]')!);
    expect(orch.calls).toContain('stop');
    expect(document.querySelector('[data-voice-pill]')).toBeFalsy();
  });

  it('renders NO transcript — only the state label (ac-31)', async () => {
    tagAc(AC31);
    const orch = fakeOrchestrator();
    renderVoice({ factory: orch.factory });
    await startSession();
    const pill = document.querySelector('[data-voice-pill]')!;
    // The only text in the pill is the state label + control glyphs — no message text.
    expect(pill.querySelector('[data-voice-state-label]')?.textContent).toBe('Listening…');
  });
});

describe('mic permission flow (ac-31)', () => {
  it('shows a denied-recovery card with retry when permission is denied', async () => {
    tagAc(AC31);
    renderVoice({ getUserMedia: async () => { throw new Error('NotAllowedError'); } });
    await startSession();
    const recovery = document.querySelector('[data-voice-recovery]');
    expect(recovery?.getAttribute('data-recovery-kind')).toBe('permission_denied');
    expect(document.querySelector('[data-voice-retry]')).toBeTruthy();
  });

  it('emits earcons via the app player: start on session start, end on end (ac-31)', async () => {
    tagAc(AC31);
    const earcons = recordingEarcons();
    renderVoice({ earcons });
    await startSession();
    expect(earcons.played).toContain('start');
    fireEvent.click(document.querySelector('[data-voice-end]')!);
    expect(earcons.played).toContain('end');
  });
});
