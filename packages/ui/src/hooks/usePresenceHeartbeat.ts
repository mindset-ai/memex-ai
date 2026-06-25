import { useEffect, useRef } from 'react';
import { tenantBase, fetchWithRetry } from '../api/http';

/**
 * usePresenceHeartbeat — the BROWSER half of spec-122's presence plane (t-7,
 * ac-16). While the tab is VISIBLE, POSTs a tiny heartbeat to
 * `POST /api/<ns>/<mx>/presence` every ~15s, declaring "I'm here, on this spec,
 * right now".
 *
 * The payload carries ONLY the spec ref — NEVER any document content. The
 * timestamp is stamped server-side as now(), so the body is just `{ ref }`.
 *
 * Visibility: presence is present-tense, so a hidden/backgrounded tab is NOT
 * "here". We use the Page Visibility API — pause the beat when `document.hidden`
 * is true, resume on `visibilitychange` when it becomes visible again. The first
 * beat fires immediately on mount (when visible) so presence registers without a
 * 15s wait.
 *
 * t-9 mounts this on the spec page; t-7 ships the hook + its unit test only.
 */

const HEARTBEAT_INTERVAL_MS = 15_000;

export function usePresenceHeartbeat(specRef: string | null | undefined): void {
  // Keep the latest ref in a ref so the interval callback always reads the
  // current value without re-installing the timer on every render.
  const refRef = useRef(specRef);
  refRef.current = specRef;

  useEffect(() => {
    if (!specRef) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const beat = (): void => {
      const ref = refRef.current;
      if (!ref) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      const base = tenantBase();
      if (!base) return;
      // Body is the spec ref ONLY — no document content. Server stamps the time.
      void fetchWithRetry(`${base}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref }),
      }).catch(() => {
        // Presence is best-effort — a dropped beat just means the row decays.
      });
    };

    const start = (): void => {
      if (timer !== null) return;
      beat(); // beat immediately so presence registers without a 15s wait
      timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    };

    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.hidden) {
        stop();
      } else {
        start();
      }
    };

    // Start only when visible; otherwise wait for the tab to surface.
    if (typeof document !== 'undefined' && document.hidden) {
      // hidden on mount — install the listener and stay paused.
    } else {
      start();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [specRef]);
}
