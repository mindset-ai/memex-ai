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

const ANCHOR = 'fixed bottom-6 right-6 z-50';

export function VoiceLayer(): React.JSX.Element | null {
  const session = useVoiceSession();
  const { pathname } = useLocation();

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
      <p className="text-text-primary">
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
          className="rounded-md px-2 py-1 text-text-secondary hover:bg-surface-hover"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
