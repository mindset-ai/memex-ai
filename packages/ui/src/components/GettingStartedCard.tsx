// spec-460 dec-2: a compact "Getting Started" card at the bottom of the sidebar,
// above the user card. Two state-aware rows:
//   1. Get the desktop app — the one-click MCP-setup path. Auto-retires when the
//      user's MCP is connected by ANY means (the spec-434 journey milestone).
//   2. Book a 30-min call — dismiss-only (dec-8); no hasSpec auto-retire.
// When no rows remain (or the card is dismissed) the card unmounts entirely, so the
// sidebar returns to exactly its pre-feature chrome. Persistent until the job is
// done, never persistent forever.
//
// No-flash guard (review finding 3): the card renders nothing until the journey
// state has resolved. It seeds mcpConnected from the in-memory journey-state cache
// (warmed by RootRedirect at landing, spec-421) so a connected user never sees the
// card flash on first paint; only a cold reload with no cache does a mount fetch.
//
// Dismissal is per-device localStorage (dec-9), user-scoped so two accounts on one
// machine don't share it, with a storage-event listener for cross-tab sync. No
// network write on dismiss.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCachedJourneyState } from '../journeys/journeyStateCache';
import { fetchJourneyStateApi } from '../api/journey';
import { useTelemetry } from '../hooks/useTelemetry';

// The download + booking pages live on the marketing site (spec-460 dec-10/dec-6).
// ?src attributes the surface; the booking alias keeps the raw HubSpot URL out of
// the app (std-31).
const DOWNLOAD_URL = 'https://www.memex.ai/download?src=sidebar-card';
const BOOK_A_CALL_URL = 'https://www.memex.ai/book-a-call?src=sidebar-card';

const callDismissedKey = (userId: string) => `memex.gettingStarted.callDismissed:${userId}`;
const cardDismissedKey = (userId: string) => `memex.gettingStarted.cardDismissed:${userId}`;
// Once-per-session guards for the display/retire signals (not persisted per-device).
const SHOWN_SESSION_KEY = 'memex.gettingStarted.shown';
const RETIRED_SESSION_KEY = 'memex.gettingStarted.appRowRetired';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* storage unavailable — non-fatal, the row just re-shows next load */
  }
}

function MonitorIcon() {
  return (
    <svg className="w-4 h-4 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path strokeLinecap="round" d="M8 20.5h8M12 17v3.5" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg className="w-4 h-4 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path strokeLinecap="round" d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </svg>
  );
}

export function GettingStartedCard({ userId }: { userId: string }) {
  const { track } = useTelemetry(true);

  // Seed from the in-memory cache so a warmed session paints correctly on the first
  // render. `resolved` is false only on a cold reload with no cache yet.
  const seeded = getCachedJourneyState();
  const [resolved, setResolved] = useState(seeded !== null);
  const [mcpConnected, setMcpConnected] = useState(!!seeded?.milestones?.mcpConnected);
  const [callDismissed, setCallDismissed] = useState(() => readFlag(callDismissedKey(userId)));
  const [cardDismissed, setCardDismissed] = useState(() => readFlag(cardDismissedKey(userId)));

  const shownFiredRef = useRef(false);

  // Cold reload with no cache: fetch once so we can decide whether to show the app
  // row. Render nothing until this resolves (no flash of a card that then vanishes).
  useEffect(() => {
    if (resolved) return;
    let alive = true;
    void fetchJourneyStateApi()
      .then((s) => {
        if (!alive) return;
        setMcpConnected(!!s.milestones?.mcpConnected);
        setResolved(true);
      })
      .catch(() => {
        // On failure, resolve as not-connected: better to offer the setup path than
        // to hide the card forever behind a transient error.
        if (alive) setResolved(true);
      });
    return () => {
      alive = false;
    };
  }, [resolved]);

  // Cross-tab dismissal sync (dec-9): re-read the flags when another tab writes them.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === callDismissedKey(userId)) setCallDismissed(readFlag(callDismissedKey(userId)));
      if (e.key === cardDismissedKey(userId)) setCardDismissed(readFlag(cardDismissedKey(userId)));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId]);

  const showAppRow = resolved && !mcpConnected;
  const showCallRow = resolved && !callDismissed;
  const visible = resolved && !cardDismissed && (showAppRow || showCallRow);

  // app_row_retired: once per session, when the user's MCP is connected (the row's
  // job is done). Fired regardless of card visibility so the retirement is measurable.
  useEffect(() => {
    if (!resolved || !mcpConnected) return;
    try {
      if (sessionStorage.getItem(RETIRED_SESSION_KEY)) return;
      sessionStorage.setItem(RETIRED_SESSION_KEY, '1');
    } catch {
      /* ignore */
    }
    track('getting_started.app_row_retired', {});
  }, [resolved, mcpConnected, track]);

  // card_shown: once per session, the first time the card is actually visible.
  useEffect(() => {
    if (!visible || shownFiredRef.current) return;
    shownFiredRef.current = true;
    try {
      if (sessionStorage.getItem(SHOWN_SESSION_KEY)) return;
      sessionStorage.setItem(SHOWN_SESSION_KEY, '1');
    } catch {
      /* ignore */
    }
    track('getting_started.card_shown', {});
  }, [visible, track]);

  const dismissCall = useCallback(() => {
    writeFlag(callDismissedKey(userId));
    setCallDismissed(true);
    track('getting_started.call_row_dismissed', {});
  }, [userId, track]);

  const dismissCard = useCallback(() => {
    writeFlag(cardDismissedKey(userId));
    setCardDismissed(true);
    track('getting_started.card_dismissed', {});
  }, [userId, track]);

  if (!visible) return null;

  return (
    <div
      data-testid="getting-started-card"
      className="rounded-lg border border-edge bg-overlay p-2"
    >
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          Getting started
        </span>
        <button
          data-testid="getting-started-dismiss-card"
          onClick={dismissCard}
          aria-label="Dismiss getting started"
          className="text-muted hover:text-secondary transition-colors text-xs leading-none p-0.5"
        >
          ✕
        </button>
      </div>

      {showAppRow && (
        <a
          data-testid="getting-started-app-row"
          href={DOWNLOAD_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track('getting_started.app_row_clicked', {})}
          className="flex items-start gap-2.5 rounded-md p-2 hover:bg-overlay transition-colors"
        >
          <span className="mt-0.5 text-secondary">
            <MonitorIcon />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-primary">Get the desktop app</span>
            <span className="block text-xs text-muted leading-snug">
              One-click MCP setup, connect your coding agent
            </span>
          </span>
        </a>
      )}

      {showCallRow && (
        <div
          data-testid="getting-started-call-row"
          className="group flex items-start gap-2.5 rounded-md p-2 hover:bg-overlay transition-colors"
        >
          <a
            href={BOOK_A_CALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track('getting_started.call_row_clicked', {})}
            className="flex min-w-0 flex-1 items-start gap-2.5"
          >
            <span className="mt-0.5 text-secondary">
              <CalendarIcon />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-primary">Book a 30-min call</span>
              <span className="block text-xs text-muted leading-snug">
                We&apos;ll show you Memex on your own workflow. 30 minutes, or we can wrap up in 15.
              </span>
            </span>
          </a>
          <button
            data-testid="getting-started-dismiss-call"
            onClick={dismissCall}
            aria-label="Dismiss book a call"
            className="flex-none text-muted hover:text-secondary transition-colors text-xs leading-none p-0.5"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
