// spec-462 — the /welcome primary button is a three-state machine so it can never
// be mistaken for a skip (the pre-462 bug: the loud blue button and the quiet
// "Skip" link both dismissed, so users read the loudest element as "play" and got
// silently skipped past the explainer).
//
//   idle    → "▶ Play now"    starts playback, does NOT navigate/dismiss   (ac-6)
//   playing → "Playing…"      inert status, not a skip target, survives pause (ac-7)
//   ended   → "Get started →" the real forward move (permanentDismiss)     (ac-8)
//
//   ac-9  : the "Skip, I'm already familiar" link is present + dismisses in every state
//   ac-10 : rewatch=1 is unchanged ("Back to Memex")
//   ac-11 : telemetry preserved — play → end → Get started emits started+completed,
//           NOT skipped

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-462/acs/ac-${n}`;

const track = vi.fn();
vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track, optedOut: false, setOptOut: vi.fn() }),
}));

const updateSession = vi.fn();
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ token: 'tok', updateSession }),
}));

const dismissWelcomeVideoApi = vi.fn(async () => ({}) as never);
vi.mock('../api/auth', () => ({
  dismissWelcomeVideoApi: () => dismissWelcomeVideoApi(),
}));

// Observe navigation without a real router move (keep MemoryRouter + useSearchParams real).
const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});

import { WelcomePage } from './WelcomePage';

function renderPage(route = '/welcome') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <WelcomePage />
    </MemoryRouter>,
  );
}

/** Give the jsdom <video> concrete playback numbers (jsdom leaves them 0 / NaN). */
function stubPlayback(video: HTMLVideoElement, currentTime: number, duration: number) {
  Object.defineProperty(video, 'currentTime', { value: currentTime, configurable: true });
  Object.defineProperty(video, 'duration', { value: duration, configurable: true });
}

// jsdom does not implement HTMLMediaElement.play(); stub it so "Play now" can call it.
let playSpy: ReturnType<typeof vi.spyOn>;

describe('spec-462 — /welcome three-state primary button', () => {
  beforeEach(() => {
    track.mockClear();
    updateSession.mockClear();
    dismissWelcomeVideoApi.mockClear();
    navigate.mockClear();
    sessionStorage.clear();
    playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined as unknown as void);
  });

  afterEach(() => {
    playSpy.mockRestore();
  });

  it('idle renders "▶ Play now"; clicking it plays the video and does NOT navigate or dismiss (ac-6)', async () => {
    tagAc(AC(6));
    renderPage();

    const cta = screen.getByTestId('welcome-video-cta');
    expect(cta).toHaveTextContent('Play now');
    expect(screen.queryByText(/Get started/)).not.toBeInTheDocument();

    await userEvent.click(cta);

    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(dismissWelcomeVideoApi).not.toHaveBeenCalled();
  });

  it('once playing the button becomes an inert "Playing…" status that survives pause and is not a skip target (ac-7)', async () => {
    tagAc(AC(7));
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;

    fireEvent.play(video);

    const status = screen.getByTestId('welcome-video-cta');
    expect(status).toHaveTextContent('Playing…');
    expect(status.tagName).not.toBe('BUTTON'); // inert — no onClick, not clickable

    // Clicking the status must not dismiss/navigate.
    await userEvent.click(status);
    expect(navigate).not.toHaveBeenCalled();
    expect(dismissWelcomeVideoApi).not.toHaveBeenCalled();

    // Pause must NOT flip the label back (native controls own resume).
    fireEvent.pause(video);
    expect(screen.getByTestId('welcome-video-cta')).toHaveTextContent('Playing…');
  });

  it('only after the video ends does the button become "Get started →" wired to permanentDismiss (ac-8)', async () => {
    tagAc(AC(8));
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 120, 120);

    // Before ended there is no "Get started".
    fireEvent.play(video);
    expect(screen.queryByText(/Get started/)).not.toBeInTheDocument();

    fireEvent.ended(video);
    const cta = screen.getByTestId('welcome-video-cta');
    expect(cta).toHaveTextContent('Get started →');

    await userEvent.click(cta);
    await waitFor(() => expect(dismissWelcomeVideoApi).toHaveBeenCalled());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/specs', { replace: true }));
    expect(sessionStorage.getItem('welcomeVideoDismissed')).toBe('1');
  });

  it('the "Skip, I\'m already familiar" link is present and dismisses in every state (ac-9)', async () => {
    tagAc(AC(9));
    const { unmount } = renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;

    // idle
    expect(screen.getByTestId('welcome-video-skip')).toBeInTheDocument();
    // playing
    fireEvent.play(video);
    expect(screen.getByTestId('welcome-video-skip')).toBeInTheDocument();
    // ended
    fireEvent.ended(video);
    expect(screen.getByTestId('welcome-video-skip')).toBeInTheDocument();

    // and it actually dismisses
    await userEvent.click(screen.getByTestId('welcome-video-skip'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/specs', { replace: true }));
    unmount();
  });

  it('rewatch mode (rewatch=1) is unchanged — "Back to Memex", no Play-now machine (ac-10)', async () => {
    tagAc(AC(10));
    renderPage('/welcome?rewatch=1');

    expect(screen.getByTestId('welcome-video-back')).toHaveTextContent('Back to Memex');
    expect(screen.queryByTestId('welcome-video-cta')).not.toBeInTheDocument();
    expect(screen.queryByText('Play now')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('welcome-video-back'));
    expect(navigate).toHaveBeenCalledWith('/specs', { replace: true });
  });

  it('play → end → "Get started" emits video_started + video_completed and NOT video_skipped (ac-11)', async () => {
    tagAc(AC(11));
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 120, 120);

    fireEvent.play(video);
    fireEvent.ended(video);
    await userEvent.click(screen.getByTestId('welcome-video-cta')); // now "Get started →"

    const kinds = (name: string) => track.mock.calls.filter((c) => c[0] === name);
    expect(kinds('onboarding.video_started')).toHaveLength(1);
    expect(kinds('onboarding.video_completed')).toHaveLength(1);
    expect(kinds('onboarding.video_skipped')).toHaveLength(0);
  });
});
