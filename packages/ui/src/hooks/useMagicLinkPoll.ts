import { useEffect, useRef, useState } from 'react';
import { magicLinkStatusApi, NotFoundError, type SessionPayload } from '../api/client';

// spec-304 t-40 (ac-30): poll the login-request surrogate so a magic-link login
// completes IN THE ORIGINATING TAB/WEBVIEW. The user requests a link here, then
// verifies it in a DIFFERENT browser/context (e.g. the external system browser
// the desktop webview hands the link to); this hook notices the surrogate flip
// to verified and adopts the session in place — no click-back, no native
// deep-link handling.
//
// Contract (server, already live):
//   pending  → { verified: false, expired: false }
//   expired  → { verified: false, expired: true }
//   verified → { verified: true, ...SessionPayload }  (SINGLE-SHOT — the row is
//              deleted on first verified read; a second poll 404s)
//   unknown  → 404 (NotFoundError)
//
// The verified read is single-shot, so the loop MUST stop the instant it sees
// verified:true and hand the session off in that same tick — otherwise the very
// next poll 404s and we'd lose the session. We guard the whole loop with a
// `done` ref so neither a verified pickup nor a terminal error can be raced by
// an in-flight poll, and so React StrictMode's double-invoke can't spawn two
// live intervals.

/** Poll cadence — fast enough to feel instant, slow enough to stay cheap. */
export const MAGIC_LINK_POLL_INTERVAL_MS = 2_500;
/** Hard stop — matches the magic-link / surrogate TTL ("expires in 15 minutes"). */
export const MAGIC_LINK_POLL_TTL_MS = 15 * 60 * 1_000;

export type MagicLinkPollPhase = 'polling' | 'verified' | 'expired';

/**
 * Drive the originating-session poll for one `loginRequestId`.
 *
 * @param loginRequestId  the surrogate id from `magicLinkRequestApi`; `null`
 *                        disables polling (no id yet / not on the magic-sent view).
 * @param onVerified      session-adoption callback — wire it to the SAME path the
 *                        rest of auth uses (`acceptSession`) so the polled login
 *                        truly completes (token persisted, context set, redirect).
 *                        Invoked AT MOST ONCE.
 * @returns the current phase: 'polling' until a terminal outcome, then 'verified'
 *          (handed off) or 'expired' (404 / TTL lapse / expired surrogate).
 */
export function useMagicLinkPoll(
  loginRequestId: string | null,
  onVerified: (session: SessionPayload) => void,
): MagicLinkPollPhase {
  const [phase, setPhase] = useState<MagicLinkPollPhase>('polling');

  // Keep the latest callback in a ref so re-creating it across renders doesn't
  // tear down and re-install the interval (which would also reset `done`).
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  useEffect(() => {
    if (!loginRequestId) return;

    // Reset for a fresh surrogate (e.g. the user requested a new link).
    setPhase('polling');

    // The single source of "this loop is over". Set before any terminal action
    // so a poll that is still in flight when we resolve can't double-fire, and
    // so a StrictMode re-mount's cleanup leaves the old loop dead.
    let done = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let ttl: ReturnType<typeof setTimeout> | null = null;

    const stop = (): void => {
      done = true;
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
      if (ttl !== null) {
        clearTimeout(ttl);
        ttl = null;
      }
    };

    const poll = async (): Promise<void> => {
      if (done) return;
      try {
        const status = await magicLinkStatusApi(loginRequestId);
        if (done) return;
        if (status.verified) {
          // SINGLE-SHOT: stop BEFORE the hand-off so no later poll can race the
          // now-deleted surrogate, then adopt the session in this same tick.
          stop();
          setPhase('verified');
          const { verified: _verified, ...session } = status;
          onVerifiedRef.current(session as SessionPayload);
          return;
        }
        if (status.expired) {
          stop();
          setPhase('expired');
        }
        // pending → keep polling.
      } catch (err) {
        if (done) return;
        // 404 ⇒ the surrogate is gone (already picked up / never existed) — a
        // dead capability. Treat as expired and stop. Transient network errors
        // (anything else) are swallowed so a blip doesn't kill the loop.
        if (err instanceof NotFoundError) {
          stop();
          setPhase('expired');
        }
      }
    };

    interval = setInterval(() => void poll(), MAGIC_LINK_POLL_INTERVAL_MS);
    ttl = setTimeout(() => {
      if (done) return;
      stop();
      setPhase('expired');
    }, MAGIC_LINK_POLL_TTL_MS);

    // Kick one poll immediately so a link verified before the first tick still
    // lands fast (the verified-elsewhere flow can complete in well under 2.5s).
    void poll();

    return stop;
  }, [loginRequestId]);

  return phase;
}
