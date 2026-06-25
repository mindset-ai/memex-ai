// spec-190 t-8 (dec-5 / ac-1 / ac-29 / ac-31) — the single voice overlay, mounted
// once at the app-shell level. Decides what shows:
//   - active session  → the floating pill, on EVERY route (persists across route
//     changes incl. agent-driven navigation, ac-29);
//   - permission-denied / error → a recovery card with retry (ac-31);
//   - otherwise → the in-view voice icon, but ONLY on registered screens (ac-29),
//     placed within the view rather than the global top bar (ac-1).
//
// Rendering it at the shell (not per page) is what makes the pill survive
// navigation; gating the icon on resolveScreenKey is what scopes it to registered
// screens without editing every page.

import { useLocation } from 'react-router-dom';
import { resolveScreenKey } from '@memex/shared';
// spec-222: the voice surface components now ship from @memex/guide-sdk. VoiceLayer
// itself STAYS app-side because it reads the route (useLocation) + the registry
// (resolveScreenKey) to gate the icon — the app-only coupling the engine sheds.
import {
  useVoiceSession,
  VoiceIcon,
  VoiceSessionPill,
  Specky,
} from '@memex/guide-sdk';
import { useEffect, useRef } from 'react';
import { useTelemetry } from '../../hooks/useTelemetry';

const ANCHOR = 'fixed bottom-6 right-6 z-50';

export function VoiceLayer(): React.JSX.Element | null {
  const session = useVoiceSession();
  const { pathname } = useLocation();
  const { track } = useTelemetry(true);
  const status = session.status;

  // Telemetry stays app-side (the SDK stays pure): observe the session state
  // machine at the shell, where every transition is visible. Maps to the voice
  // funnel — adoption (started), the mic-permission drop-off, and dwell.
  const prevStatus = useRef<string | null>(null);
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevStatus.current;
    if (prev === status) return;
    if (status === 'active' && prev !== 'active') {
      startedAt.current = Date.now();
      track('voice.session_started');
      // A real prompt resolved to granted only when we came through the request.
      if (prev === 'requesting_permission') {
        track('voice.mic_permission_result', { result: 'granted' });
      }
    } else if (status === 'permission_denied' && prev !== 'permission_denied') {
      track('voice.mic_permission_result', { result: 'denied' });
    }
    if (prev === 'active' && status !== 'active') {
      const ms = startedAt.current != null ? Date.now() - startedAt.current : undefined;
      track('voice.session_ended', ms != null ? { durationMs: ms } : undefined);
      startedAt.current = null;
    }
    prevStatus.current = status;
  }, [status, track]);

  // The voice entry point (the Specky icon) is presented in the inactive/
  // requesting/mic-unavailable branch on registered screens — the adoption
  // denominator. Fire once per mount (not per render), surface = 'icon'.
  const iconVisible =
    status !== 'active' &&
    status !== 'permission_denied' &&
    status !== 'error' &&
    resolveScreenKey(pathname) !== null;
  const iconShownFired = useRef(false);
  useEffect(() => {
    if (iconVisible && !iconShownFired.current) {
      iconShownFired.current = true;
      track('voice.icon_shown', { surface: 'icon' });
    }
  }, [iconVisible, track]);

  if (session.status === 'active') {
    return (
      <div className={ANCHOR}>
        <VoiceSessionPill />
      </div>
    );
  }

  if (session.status === 'permission_denied' || session.status === 'error') {
    return (
      <div className={ANCHOR}>
        <VoiceRecovery />
      </div>
    );
  }

  // Inactive / requesting / mic-unavailable → the icon, on registered screens only.
  // spec-197: the entry doorway IS Specky — present and alive (the animated idle
  // loop, dec-2 revised 2026-06-08 / ac-8). dec-2 originally kept this a quiet
  // static frame, but the product owner chose the livelier doorway so the guide
  // reads as inviting rather than dormant. Reduced-motion still freezes it to the
  // base pose via the SVG's own media query (dec-5), so it stays calm for
  // motion-sensitive users without any code here.
  if (resolveScreenKey(pathname) === null) return null;
  return (
    <div className={ANCHOR}>
      <VoiceIcon mark={<Specky size={40} />} />
    </div>
  );
}

/** Denied-permission / error recovery (ac-31). */
function VoiceRecovery(): React.JSX.Element {
  const session = useVoiceSession();
  const denied = session.status === 'permission_denied';
  return (
    <div
      data-voice-recovery
      data-recovery-kind={denied ? 'permission_denied' : 'error'}
      className="max-w-xs rounded-lg bg-surface p-3 text-sm shadow-lg ring-1 ring-border"
    >
      <p className="text-primary">
        {denied
          ? 'Microphone access is blocked. Enable it for this site in your browser, then retry.'
          : `The voice guide hit an error${session.error ? `: ${session.error}` : ''}.`}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          data-voice-retry
          onClick={() => void session.retryPermission()}
          className="rounded-md bg-accent px-2 py-1 text-white"
        >
          Retry
        </button>
        <button
          type="button"
          data-voice-dismiss
          onClick={session.end}
          className="rounded-md px-2 py-1 text-secondary hover:bg-card-hover"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
