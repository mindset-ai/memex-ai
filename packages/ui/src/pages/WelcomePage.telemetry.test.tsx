import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-460 acceptance criteria (mindset-prod/memex-building-itself).
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-460/acs/ac-${n}`;
// spec-507: the page is now opt-in only — one mode, one exit, no dismiss writes.
const AC_ONE_MODE = 'mindset-prod/memex-building-itself/specs/spec-507/acs/ac-9';

// spec-444 welcome-video instrumentation. The onboarding.video_* events ride the
// SAME analytics client as every other front-end signal — useTelemetry().track()
// (std-35 Recipe A). useTelemetry no-ops without a live tenant in jsdom, so we stub
// the hook to observe the exact call the component makes (mirrors the pattern in
// TagFilter.telemetry.test.tsx).
const track = vi.fn();
vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track, optedOut: false, setOptOut: vi.fn() }),
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
      video_id: 'welcome-to-memex-v6-1080p',
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
    expect(completed[0][1]).toMatchObject({ video_id: 'welcome-to-memex-v6-1080p', percent_watched: 100 });
  });

  // spec-507: "skipped" no longer means "clicked the skip link" (there isn't one) —
  // it means the viewer started the video and left before it ended.
  it('fires onboarding.video_skipped ONCE when the viewer leaves mid-video', async () => {
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 10, 120);
    fireEvent.play(video);

    await userEvent.click(screen.getByTestId('welcome-video-back'));

    const skipped = track.mock.calls.filter((c) => c[0] === 'onboarding.video_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][1]).toMatchObject({ video_id: 'welcome-to-memex-v6-1080p', position_seconds: 10 });
  });

  it('does NOT fire onboarding.video_skipped once the video has completed', async () => {
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 120, 120);
    fireEvent.play(video);
    fireEvent.ended(video);

    await userEvent.click(screen.getByTestId('welcome-video-back'));

    expect(track.mock.calls.filter((c) => c[0] === 'onboarding.video_skipped')).toHaveLength(0);
    expect(track.mock.calls.filter((c) => c[0] === 'onboarding.video_completed')).toHaveLength(1);
  });

  it('does NOT fire onboarding.video_skipped for a visitor who never pressed play', async () => {
    renderPage();
    await userEvent.click(screen.getByTestId('welcome-video-back'));
    expect(track.mock.calls.filter((c) => c[0] === 'onboarding.video_skipped')).toHaveLength(0);
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

// spec-460 dec-1/dec-7: the "book a call" line is hidden during playback, revealed
// once the viewer is ≥75% through (or the video ends), links to the neutral booking
// alias in a new tab, and never gates the path back to /specs.
describe('WelcomePage — spec-460 book-a-call reveal', () => {
  beforeEach(() => {
    track.mockClear();
    sessionStorage.clear();
  });

  it('hides the call CTA before the reveal threshold and shows it after, linking to the alias in a new tab (ac-8, ac-20, ac-7)', () => {
    tagAc(AC(8));
    tagAc(AC(20)); // welcome-video surface: alias + src=welcome-video + noopener
    tagAc(AC(7)); // reveal is instrumented + links to the neutral alias
    renderPage();
    const cta = screen.getByTestId('welcome-video-call-cta');
    const link = cta.querySelector('a')!;

    // Hidden pre-reveal: aria-hidden, not focusable, no shown event.
    expect(cta).toHaveAttribute('aria-hidden', 'true');
    expect(link).toHaveAttribute('tabindex', '-1');
    expect(track.mock.calls.filter((c) => c[0] === 'onboarding.video_call_cta_shown')).toHaveLength(0);

    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 90, 100); // 90% > 75% threshold
    fireEvent.timeUpdate(video);

    expect(cta).toHaveAttribute('aria-hidden', 'false');
    expect(link).toHaveAttribute('tabindex', '0');
    expect(link).toHaveAttribute('href', 'https://www.memex.ai/book-a-call?src=welcome-video');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // The single exit (spec-507) is still present alongside the revealed CTA.
    expect(screen.getByTestId('welcome-video-back')).toBeInTheDocument();
  });

  it('reveals at ≥75% via playback/seek, and via ended, and stays shown once revealed (fires once) (ac-9)', () => {
    tagAc(AC(9));
    renderPage();
    const cta = screen.getByTestId('welcome-video-call-cta');
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;

    // Below threshold: still hidden.
    stubPlayback(video, 50, 100);
    fireEvent.timeUpdate(video);
    expect(cta).toHaveAttribute('aria-hidden', 'true');

    // Cross threshold: revealed.
    stubPlayback(video, 76, 100);
    fireEvent.timeUpdate(video);
    expect(cta).toHaveAttribute('aria-hidden', 'false');

    // Seek back below threshold: stays revealed (no re-hide).
    stubPlayback(video, 10, 100);
    fireEvent.timeUpdate(video);
    expect(cta).toHaveAttribute('aria-hidden', 'false');

    // The shown event fired exactly once across all those updates.
    expect(track.mock.calls.filter((c) => c[0] === 'onboarding.video_call_cta_shown')).toHaveLength(1);
  });

  it('reveals on ended even if timeupdate never crossed the threshold (ac-9)', () => {
    tagAc(AC(9));
    renderPage();
    const cta = screen.getByTestId('welcome-video-call-cta');
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;

    stubPlayback(video, 100, 100);
    fireEvent.ended(video);
    expect(cta).toHaveAttribute('aria-hidden', 'false');
  });

  it('fires onboarding.video_call_cta_shown on reveal and _clicked on click (ac-21, ac-7)', async () => {
    tagAc(AC(21)); // welcome_video.call_cta_shown / _clicked events fire
    tagAc(AC(7));
    renderPage();
    const video = screen.getByTestId('welcome-video-player') as HTMLVideoElement;
    stubPlayback(video, 90, 100);
    fireEvent.timeUpdate(video);
    expect(track.mock.calls.filter((c) => c[0] === 'onboarding.video_call_cta_shown')).toHaveLength(1);

    const link = screen.getByTestId('welcome-video-call-cta').querySelector('a')!;
    await userEvent.click(link);
    expect(track.mock.calls.filter((c) => c[0] === 'onboarding.video_call_cta_clicked')).toHaveLength(1);
  });

  it('points the video at the v6 CDN asset (ac-19)', () => {
    tagAc(AC(19));
    renderPage();
    const src = screen.getByTestId('welcome-video-player').getAttribute('src');
    expect(src).toBe(
      'https://storage.googleapis.com/memex-ai-prod-app-static/media/welcome-to-memex-v6-1080p.mp4',
    );
  });

  it('keeps the spec-444 headline and subtitle copy unchanged (ac-22)', () => {
    tagAc(AC(22));
    renderPage();
    expect(screen.getByText("Let's dive in.")).toBeInTheDocument();
    expect(
      screen.getByText(/Here's a quick look to get you started with Memex\./),
    ).toBeInTheDocument();
    expect(screen.getByText('Hit play to start.')).toBeInTheDocument();
  });
});

// spec-507 ac-9: one mode, one exit. The gate is gone, so every affordance that
// existed to soften a compulsory interstitial is gone with it — and the page must
// no longer write the dismiss flag or the sessionStorage suppression key, because
// nothing reads either for routing any more.
describe('WelcomePage — spec-507: single opt-in mode', () => {
  beforeEach(() => {
    track.mockClear();
    sessionStorage.clear();
  });

  function renderWithSpecs(route = '/welcome') {
    return render(
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/specs" element={<div data-testid="specs-board">specs</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('renders no skip link, no × close, and no three-state play button', () => {
    tagAc(AC_ONE_MODE);
    renderPage();
    expect(screen.queryByTestId('welcome-video-skip')).toBeNull();
    expect(screen.queryByTestId('welcome-video-close')).toBeNull();
    expect(screen.queryByTestId('welcome-video-cta')).toBeNull();
    expect(screen.queryByText(/Skip, I'm already familiar/)).toBeNull();
    expect(screen.getByTestId('welcome-video-back')).toBeInTheDocument();
  });

  it('"Back to Memex" is the single exit and lands on /specs', async () => {
    tagAc(AC_ONE_MODE);
    renderWithSpecs();
    await userEvent.click(screen.getByTestId('welcome-video-back'));
    expect(screen.getByTestId('specs-board')).toBeInTheDocument();
  });

  it('writes no sessionStorage suppression flag on exit', async () => {
    tagAc(AC_ONE_MODE);
    renderWithSpecs();
    await userEvent.click(screen.getByTestId('welcome-video-back'));
    expect(sessionStorage.getItem('welcomeVideoDismissed')).toBeNull();
  });

  it('behaves identically with the retired ?rewatch=1 parameter (one mode only)', () => {
    tagAc(AC_ONE_MODE);
    renderPage('/welcome?rewatch=1');
    expect(screen.getByTestId('welcome-video-back')).toBeInTheDocument();
    expect(screen.queryByTestId('welcome-video-cta')).toBeNull();
    expect(screen.queryByTestId('welcome-video-close')).toBeNull();
  });
});
