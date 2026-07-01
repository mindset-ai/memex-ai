// spec-444: full-page welcome video shown to every new user on first authenticated
// load. Comes after /onboarding (name capture) but before the specs board. Two
// dismiss exits ("Get started" + "Skip") write video_welcomed_at via the PATCH
// and also set sessionStorage so the gate doesn't loop within the same tab.
// The extended scope (ac-17): the gate re-shows on any session where the user
// has not yet created a spec — so the only true permanent suppression is creating
// a spec, not clicking "Get started". sessionStorage suppress covers the current
// tab so clicking "Get started" still navigates away cleanly within the session.
// The × button writes sessionStorage only — the video re-appears on next login.

import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { dismissWelcomeVideoApi } from '../api/auth';

const VIDEO_URL =
  'https://storage.googleapis.com/memex-ai-prod-app-static/media/welcome-to-memex-v2.mp4';

export function WelcomePage() {
  const { token, updateSession } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isRewatch = searchParams.get('rewatch') === '1';
  const [dismissing, setDismissing] = useState(false);

  const permanentDismiss = useCallback(async () => {
    if (dismissing) return;
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
  }, [dismissing, token, updateSession, navigate]);

  const sessionDismiss = useCallback(() => {
    sessionStorage.setItem('welcomeVideoDismissed', '1');
    navigate('/specs', { replace: true });
  }, [navigate]);

  const rewatchExit = useCallback(() => {
    navigate(-1);
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

      <div className="w-full max-w-[560px] flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900">Let's dive in.</h1>
          <p className="mt-2 text-base text-gray-600">
            Here&apos;s a quick look to get you started with Memex.{' '}
            <span className="font-semibold">Hit play to start.</span>
          </p>
        </div>

        <video
          data-testid="welcome-video-player"
          src={VIDEO_URL}
          controls
          preload="metadata"
          className="w-full rounded-lg"
          style={{ aspectRatio: '16/9' }}
        />

        {!isRewatch ? (
          <>
            <button
              data-testid="welcome-video-cta"
              onClick={permanentDismiss}
              disabled={dismissing}
              className="w-full py-3 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-base transition-colors disabled:opacity-60"
            >
              {dismissing ? 'One moment…' : 'Get started →'}
            </button>
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
      </div>
    </div>
  );
}
