// spec-444: full-page welcome video shown to every new user on first authenticated
// load. Comes after /onboarding (name capture) but before the specs board. Two
// dismiss exits ("Get started" + "Skip") write video_welcomed_at via the PATCH
// and also set sessionStorage so the gate doesn't loop within the same tab.
// The extended scope (ac-17): the gate re-shows on any session where the user
// has not yet created a spec — so the only true permanent suppression is creating
// a spec, not clicking "Get started". sessionStorage suppress covers the current
// tab so clicking "Get started" still navigates away cleanly within the session.
// The × button writes sessionStorage only — the video re-appears on next login.

import { useCallback, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { dismissWelcomeVideoApi } from '../api/auth';
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
// near-finishers while staying roughly synced to the wind-down. Originally 85%
// against the ~3-min v4 cut; lowered for the 4:43 v6 cut so the reveal lands at
// ~3:33 instead of ~4:01 (issue-1 — fewer viewers survive to 85% of a longer video).
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
  const { token, updateSession } = useAuth();
  const navigate = useNavigate();
  const { track } = useTelemetry(true);
  const [searchParams] = useSearchParams();
  const isRewatch = searchParams.get('rewatch') === '1';
  const [dismissing, setDismissing] = useState(false);

  // spec-462: the primary button is a three-state machine so it can never be
  // mistaken for a skip. Before spec-462 the loud blue button and the quiet
  // "Skip" link both called permanentDismiss — the loudest element on the page
  // was a disguised skip, and users read it as "play". Now:
  //   idle    → "▶ Play now"      (loud blue)  → starts playback
  //   playing → "Playing…"        (quiet)      → inert status, not a skip target
  //   ended   → "Get started →"   (loud blue)  → permanentDismiss (the real exit)
  // The "leave without watching" job is already fully covered by the ever-present
  // "Skip" link, which frees the blue button to become the play affordance. Only
  // the first-run (non-rewatch) path uses this; rewatch keeps its "Back to Memex".
  const [buttonPhase, setButtonPhase] = useState<'idle' | 'playing' | 'ended'>('idle');

  // spec-444 instrumentation. Refs (not state) so the once-per-view guards can be
  // read/written inside stable useCallbacks without re-creating them, and so
  // replay / seek / pause-resume / multiple play events never re-fire an event.
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

  // spec-462: clicking "▶ Play now" starts playback. Guarded for jsdom/autoplay —
  // play() is unimplemented in jsdom (throws) and can reject under autoplay policy;
  // either way onPlay simply won't fire and the button stays in idle, which is fine.
  const playVideo = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* jsdom / blocked autoplay — no-op */
    }
  }, []);

  const onVideoPlay = useCallback(() => {
    // spec-462: idle → playing on first play; once ended, a replay keeps the
    // "Get started →" state (the forward move stays available).
    setButtonPhase((p) => (p === 'ended' ? 'ended' : 'playing'));
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
    setButtonPhase('ended'); // spec-462: reveal the real "Get started →" forward move
    revealCallCta(); // a short video the viewer finishes should always show the CTA
    if (completedRef.current) return; // fire once per view
    completedRef.current = true;
    track('onboarding.video_completed', videoProps(videoRef.current));
  }, [track, revealCallCta]);

  const onCallCtaClick = useCallback(() => {
    track('onboarding.video_call_cta_clicked', videoProps(videoRef.current));
  }, [track]);

  // Skip = a dismiss BEFORE completion. At most once, and never if the video
  // already completed (a completed watch that then dismisses is not a skip).
  const trackSkip = useCallback(() => {
    if (completedRef.current || skippedRef.current) return;
    skippedRef.current = true;
    track('onboarding.video_skipped', videoProps(videoRef.current));
  }, [track]);

  const permanentDismiss = useCallback(async () => {
    if (dismissing) return;
    trackSkip();
    setDismissing(true);
    try {
      const session = await dismissWelcomeVideoApi(token);
      updateSession(session);
    } catch {
      // Optimistic: navigate even on failure — user will see video again next login.
    }
    // Suppress the gate for the rest of this tab session so the returning-user
    // scope gate (ac-17: re-shows when !hasSpec) doesn't immediately loop them
    // back to /welcome after they click "Get started" or "Skip".
    sessionStorage.setItem('welcomeVideoDismissed', '1');
    navigate('/specs', { replace: true });
  }, [dismissing, trackSkip, token, updateSession, navigate]);

  const sessionDismiss = useCallback(() => {
    trackSkip();
    sessionStorage.setItem('welcomeVideoDismissed', '1');
    navigate('/specs', { replace: true });
  }, [trackSkip, navigate]);

  // Rewatch exit (Back to Memex / × in rewatch mode) lands on the specs board,
  // consistent with the two first-run exits above. navigate(-1) used to send the
  // user back to wherever they opened rewatch from (e.g. Home), which is not where
  // they expect to land after the video.
  const rewatchExit = useCallback(() => {
    navigate('/specs', { replace: true });
  }, [navigate]);

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-6 py-10 relative">
      {/* × close button — session-only dismiss (or back-nav in rewatch mode) */}
      <button
        data-testid="welcome-video-close"
        onClick={isRewatch ? rewatchExit : sessionDismiss}
        className="absolute top-5 right-5 p-2 text-gray-400 hover:text-gray-600 transition-colors"
        aria-label="Close"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* spec-460 issue-1: the column is video-first — 960px wide for the player
          (the v6 cut is UI screen capture; legibility wants size), while the
          button/link cluster below stays capped at 560px so the CTA doesn't
          stretch to banner width. */}
      <div className="w-full max-w-[960px] flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900">Let's dive in.</h1>
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
        {!isRewatch ? (
          <>
            {/* spec-462: one primary button, three states. Same testid + reserved
                height across states so the layout never jumps. idle/ended are the
                loud blue CTA; playing is a quiet, inert status so it can't be
                mistaken for a skip target. */}
            {buttonPhase === 'idle' && (
              <button
                data-testid="welcome-video-cta"
                onClick={playVideo}
                className="w-full py-3 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-base transition-colors"
              >
                ▶ Play now
              </button>
            )}
            {buttonPhase === 'playing' && (
              <div
                data-testid="welcome-video-cta"
                aria-live="polite"
                className="w-full py-3 px-4 rounded-lg bg-gray-100 text-gray-400 font-semibold text-base text-center select-none"
              >
                Playing…
              </div>
            )}
            {buttonPhase === 'ended' && (
              <button
                data-testid="welcome-video-cta"
                onClick={permanentDismiss}
                disabled={dismissing}
                className="w-full py-3 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-base transition-colors disabled:opacity-60"
              >
                {dismissing ? 'One moment…' : 'Get started →'}
              </button>
            )}
            <button
              data-testid="welcome-video-skip"
              onClick={permanentDismiss}
              disabled={dismissing}
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors text-center"
            >
              Skip, I&apos;m already familiar with Memex
            </button>
          </>
        ) : (
          <button
            data-testid="welcome-video-back"
            onClick={rewatchExit}
            className="w-full py-3 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-base transition-colors"
          >
            Back to Memex
          </button>
        )}

        {/* spec-460 dec-1/dec-7: quiet "book a call" line, hidden until the viewer
            reaches ~85% of the video (or finishes it), then faded in. It never gates
            the path to /specs — the primary CTA above stays dominant. Kept in the DOM
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
