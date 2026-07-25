// The intro-video page. Originally spec-444's compulsory first-run interstitial;
// spec-507 retired the gate, so this is now a page you can only arrive at on
// purpose — the "Watch intro video" entry in the account menu.
//
// That change is why the page has one mode and one exit. Everything that used to
// soften a wall is gone: the spec-462 three-state play button (it existed because
// the loud blue CTA was a disguised skip), the "Skip, I'm already familiar with
// Memex" link, the × session-dismiss, and the `?rewatch=1` branch (every visit is
// a rewatch now). The page no longer writes `video_welcomed_at` or any
// sessionStorage suppression flag — nothing reads them for routing.
//
// What stays: the player, the spec-460 book-a-call reveal, and the five
// onboarding.video_* usage events, which now measure deliberate watches.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTelemetry } from '../hooks/useTelemetry';

const VIDEO_URL =
  'https://storage.googleapis.com/memex-ai-prod-app-static/media/welcome-to-memex-v6-1080p.mp4';

// Stable, low-cardinality identifier for this video — the filename stem of
// VIDEO_URL. Kept as its own const so a src bump is a one-line, deliberate change
// (props carry ids/counts only — std-35 cl-5).
const VIDEO_ID = 'welcome-to-memex-v6-1080p';

// spec-460: the "book a call" CTA revealed near the end of the video points at the
// neutral booking alias on the marketing site (never the raw HubSpot URL — std-31,
// dec-6). ?src attributes the booking to this surface.
const BOOK_A_CALL_URL = 'https://www.memex.ai/book-a-call?src=welcome-video';

// spec-460 dec-7: reveal the call CTA once the viewer is ≥75% through the video.
// A strict "on ended" reveal would reach far fewer viewers; the fraction catches
// near-finishers while staying roughly synced to the wind-down.
const CALL_CTA_REVEAL_FRACTION = 0.75;

// Build the numeric playback props shared by every onboarding.video_* event.
// duration is NaN until metadata loads, so percent_watched is guarded against
// NaN / divide-by-zero and every value is rounded (ids + counts only — no content).
function videoProps(video: HTMLVideoElement | null): {
  video_id: string;
  position_seconds: number;
  duration_seconds: number;
  percent_watched: number;
} {
  const position = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
  const percent = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;
  return {
    video_id: VIDEO_ID,
    position_seconds: Math.round(position),
    duration_seconds: Math.round(duration),
    percent_watched: Math.round(percent),
  };
}

export function WelcomePage() {
  const navigate = useNavigate();
  const { track } = useTelemetry(true);

  // Refs (not state) so the once-per-view guards can be read/written inside stable
  // useCallbacks without re-creating them, and so replay / seek / pause-resume /
  // multiple play events never re-fire an event.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const startedRef = useRef(false);
  const completedRef = useRef(false);
  const skippedRef = useRef(false);

  // spec-460 dec-7: the "book a call" CTA is hidden during playback and revealed
  // once the viewer crosses CALL_CTA_REVEAL_FRACTION (via natural playback, a seek
  // past the threshold, or the ended event). Once shown it stays shown — a
  // seek-back must not re-hide it. The ref guards the reveal event to once-per-view.
  const [callCtaShown, setCallCtaShown] = useState(false);
  const callCtaShownRef = useRef(false);

  const revealCallCta = useCallback(() => {
    if (callCtaShownRef.current) return; // reveal + fire once per view
    callCtaShownRef.current = true;
    setCallCtaShown(true);
    track('onboarding.video_call_cta_shown', videoProps(videoRef.current));
  }, [track]);

  const onVideoPlay = useCallback(() => {
    if (startedRef.current) return; // fire once per view
    startedRef.current = true;
    track('onboarding.video_started', videoProps(videoRef.current));
  }, [track]);

  // Reveal decisions never run before metadata loads (duration is NaN until then,
  // so the fraction guard below is false and nothing reveals prematurely).
  const onVideoTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    if (v.currentTime / v.duration >= CALL_CTA_REVEAL_FRACTION) revealCallCta();
  }, [revealCallCta]);

  const onVideoEnded = useCallback(() => {
    revealCallCta(); // a viewer who finishes should always see the CTA
    if (completedRef.current) return; // fire once per view
    completedRef.current = true;
    track('onboarding.video_completed', videoProps(videoRef.current));
  }, [track, revealCallCta]);

  const onCallCtaClick = useCallback(() => {
    track('onboarding.video_call_cta_clicked', videoProps(videoRef.current));
  }, [track]);

  // spec-507: with no skip link and no dismiss button, "skipped" now means exactly
  // one thing — the viewer started the video and left before it ended. Fired at
  // most once, from whichever comes first: the exit button or unmount.
  const trackSkip = useCallback(() => {
    if (!startedRef.current || completedRef.current || skippedRef.current) return;
    skippedRef.current = true;
    track('onboarding.video_skipped', videoProps(videoRef.current));
  }, [track]);

  // The ref indirection keeps the unmount effect's dependency list empty, so it
  // runs on real unmount only — not on every re-render of a changing callback.
  const trackSkipRef = useRef(trackSkip);
  trackSkipRef.current = trackSkip;
  useEffect(() => {
    return () => trackSkipRef.current();
  }, []);

  const exit = useCallback(() => {
    trackSkip();
    navigate('/specs', { replace: true });
  }, [trackSkip, navigate]);

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-6 py-10 relative">
      {/* spec-460 issue-1: the column is video-first — 960px wide for the player
          (the v6 cut is UI screen capture; legibility wants size), while the
          button/link cluster below stays capped at 560px so the CTA doesn't
          stretch to banner width. */}
      <div className="w-full max-w-[960px] flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900">Let&apos;s dive in.</h1>
          <p className="mt-2 text-base text-gray-600">
            Here&apos;s a quick look to get you started with Memex.{' '}
            <span className="font-semibold">Hit play to start.</span>
          </p>
        </div>

        <video
          ref={videoRef}
          data-testid="welcome-video-player"
          src={VIDEO_URL}
          controls
          preload="metadata"
          onPlay={onVideoPlay}
          onPlaying={onVideoPlay}
          onTimeUpdate={onVideoTimeUpdate}
          onEnded={onVideoEnded}
          className="w-full mx-auto rounded-lg"
          // The v6 asset is 1128×720 (~1.567:1, not 16:9) — the box matches the
          // video exactly so nothing letterboxes. The max-width term caps the
          // rendered height at ~65vh (width = height × 1.5667) so heading +
          // video + CTA stay on-screen together on shorter laptop viewports.
          style={{ aspectRatio: '1128 / 720', maxWidth: 'min(100%, calc(65vh * 1.5667))' }}
        />

        {/* Controls keep the original 560px measure under the wider video. */}
        <div className="w-full max-w-[560px] mx-auto flex flex-col gap-6">
          <button
            data-testid="welcome-video-back"
            onClick={exit}
            className="w-full py-3 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-base transition-colors"
          >
            Back to Memex
          </button>

          {/* spec-460 dec-1/dec-7: quiet "book a call" line, hidden until the viewer
              reaches 75% of the video (or finishes it), then faded in. Kept in the DOM
              so the fade can run, but non-focusable and hidden from AT until revealed. */}
          <p
            data-testid="welcome-video-call-cta"
            className={`text-center text-sm text-gray-500 transition-opacity duration-500 motion-reduce:transition-none ${
              callCtaShown ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            aria-hidden={!callCtaShown}
          >
            Prefer a guided tour?{' '}
            <a
              href={BOOK_A_CALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onCallCtaClick}
              tabIndex={callCtaShown ? 0 : -1}
              className="text-blue-600 hover:text-blue-700 underline underline-offset-2 font-medium"
            >
              Book a 30-minute call with us
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
