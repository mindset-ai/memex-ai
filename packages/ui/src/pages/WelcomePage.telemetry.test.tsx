import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// spec-444 welcome-video instrumentation. The onboarding.video_* events ride the
// SAME analytics client as every other front-end signal — useTelemetry().track()
// (std-35 Recipe A). useTelemetry no-ops without a live tenant in jsdom, so we stub
// the hook to observe the exact call the component makes (mirrors the pattern in
// TagFilter.telemetry.test.tsx).
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

describe('WelcomePage — onboarding.video_* telemetry', () => {
  beforeEach(() => {
    track.mockClear();
    updateSession.mockClear();
    dismissWelcomeVideoApi.mockClear();
    sessionStorage.clear();
  });

  it('fires onboarding.video_started ONCE with the guarded props on first play', () => {
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 3, 120);

    fireEvent.play(video);
    fireEvent.playing(video); // resume / multiple play events must not re-fire
    fireEvent.play(video);

    const started = track.mock.calls.filter((c) => c[0] === 'onboarding.video_started');
    expect(started).toHaveLength(1);
    expect(started[0][1]).toEqual({
      video_id: 'welcome-to-memex-v2',
      position_seconds: 3,
      duration_seconds: 120,
      percent_watched: 3, // 3/120 = 2.5 → rounded
    });
  });

  it('fires onboarding.video_completed ONCE on ended', () => {
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 120, 120);

    fireEvent.ended(video);
    fireEvent.ended(video);

    const completed = track.mock.calls.filter((c) => c[0] === 'onboarding.video_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0][1]).toMatchObject({ video_id: 'welcome-to-memex-v2', percent_watched: 100 });
  });

  it('fires onboarding.video_skipped ONCE when the CTA dismisses before completion', async () => {
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 10, 120);
    fireEvent.play(video);

    await userEvent.click(screen.getByTestId('welcome-video-cta'));

    const skipped = track.mock.calls.filter((c) => c[0] === 'onboarding.video_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][1]).toMatchObject({ video_id: 'welcome-to-memex-v2', position_seconds: 10 });
    await waitFor(() => expect(dismissWelcomeVideoApi).toHaveBeenCalled());
  });

  it('fires onboarding.video_skipped when the × close (session dismiss) fires before completion', async () => {
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 5, 120);
    fireEvent.play(video);

    await userEvent.click(screen.getByTestId('welcome-video-close'));

    expect(track.mock.calls.filter((c) => c[0] === 'onboarding.video_skipped')).toHaveLength(1);
  });

  it('does NOT fire onboarding.video_skipped once the video has completed', async () => {
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 120, 120);
    fireEvent.ended(video);

    await userEvent.click(screen.getByTestId('welcome-video-cta'));

    expect(track.mock.calls.filter((c) => c[0] === 'onboarding.video_skipped')).toHaveLength(0);
    expect(track.mock.calls.filter((c) => c[0] === 'onboarding.video_completed')).toHaveLength(1);
  });

  it('guards percent_watched against NaN/zero duration (metadata not yet loaded)', () => {
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    // duration NaN (default in jsdom before metadata) → percent must be 0, not NaN.
    fireEvent.play(video);

    const started = track.mock.calls.find((c) => c[0] === 'onboarding.video_started');
    expect(started?.[1]).toMatchObject({ percent_watched: 0, duration_seconds: 0 });
  });
});
