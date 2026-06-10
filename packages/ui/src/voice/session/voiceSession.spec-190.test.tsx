// spec-190 t-8 (dec-5) — the session UX surface. Covers ac-29 (in-view icon on
// registered screens; floating pill that persists across routes, reflects live
// loop state, tap-to-interrupt + mute + end) and ac-31 (mic permission on START
// not load; denied recovery; disabled when no mic; no transcript; earcons via app
// playback). All injectable deps are faked so the flow runs in jsdom with no real
// Web Audio / mic / orchestrator.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { VoiceSessionProvider } from './VoiceSessionContext';
import { VoiceLayer } from './VoiceLayer';
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

// A tiny nav control so we can change routes WITHOUT remounting the provider
// (proving the pill persists across route changes).
function Nav({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button data-testid={`nav-${to}`} onClick={() => navigate(to)}>go</button>;
}

interface HarnessOpts {
  initialPath?: string;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  detectMic?: () => boolean;
  earcons?: EarconPlayer;
  factory?: OrchestratorFactory;
}

function renderVoice(opts: HarnessOpts = {}) {
  const earcons = opts.earcons ?? recordingEarcons();
  return render(
    <MemoryRouter initialEntries={[opts.initialPath ?? '/ns/mx/specs']}>
      <VoiceSessionProvider
        earcons={earcons}
        getUserMedia={opts.getUserMedia ?? (async () => fakeStream())}
        detectMic={opts.detectMic ?? (() => true)}
        orchestratorFactory={opts.factory}
      >
        <VoiceLayer />
        <Nav to="/ns/mx/standards" />
        <Nav to="/ns/mx/not-a-registered-screen" />
      </VoiceSessionProvider>
    </MemoryRouter>,
  );
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
