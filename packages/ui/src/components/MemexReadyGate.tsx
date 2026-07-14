// spec-474 dec-6 (t-3) — the "Getting your Memex ready…" first-load blocker.
//
// Wraps the authenticated app. On first authenticated load it reads readiness from
// GET /api/me; a brand-new user whose personal Memex has not yet been content-seeded
// is shown a short blocker while the SPA drives POST /api/me/provision, then the app
// renders. Provisioned users (the overwhelming majority) never see the blocker — the
// check is a single fast GET, and once known-ready we short-circuit for the rest of
// the session so navigation never re-checks.
//
// Readiness is gated on email verification. A just-signed-up user is admitted with
// emailVerified=false and must confirm their email first (VerifyEmailGate, rendered by
// the routes inside `children`). Provisioning — and the "Getting your Memex ready…"
// blocker — must NOT run for that user: otherwise the blocker pre-empts the "Confirm
// your email" screen the moment the readiness GET reports "not provisioned". So while
// unverified we render children untouched (letting VerifyEmailGate show) and only kick
// off the readiness check once the session flips to verified.

import { useEffect, useState, type ReactNode } from 'react';
import { fetchPersonalMemexProvisioned, provisionPersonalMemex } from '../api/provision';

// Session-lived latch: once we know this session's Memex is ready, every later mount
// of the gate (each navigation) skips the network entirely.
let knownReady = false;

type State = 'checking' | 'provisioning' | 'ready';

function GettingReadyBlocker() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-page text-primary"
    >
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-primary"
        aria-hidden="true"
      />
      <p className="text-sm font-medium">Getting your Memex ready…</p>
    </div>
  );
}

export function MemexReadyGate({
  children,
  emailVerified,
}: {
  children: ReactNode;
  emailVerified: boolean;
}) {
  const [state, setState] = useState<State>(knownReady ? 'ready' : 'checking');

  useEffect(() => {
    if (knownReady) {
      setState('ready');
      return;
    }
    // Defer readiness until the email is verified. An unverified user stays in
    // 'checking' (which renders children), so the routes' VerifyEmailGate — "Confirm
    // your email" — shows instead of the blocker. When the session later flips to
    // verified (VerifyEmailGate polls refreshSession), this effect re-runs via its
    // `emailVerified` dep and provisioning kicks off then.
    if (!emailVerified) return;
    // Guards STATE writes only — never the network calls. Under React StrictMode the
    // mount→cleanup→mount cycle would otherwise cancel the in-flight request before the
    // POST fired (and a `started` ref would make the second mount skip it), so a brand-new
    // user was never provisioned in dev/e2e. Both the GET and the idempotent POST must run
    // to completion; only the resulting setState is suppressed once this instance unmounts.
    let active = true;

    void (async () => {
      try {
        const provisioned = await fetchPersonalMemexProvisioned();
        if (provisioned) {
          knownReady = true;
          if (active) setState('ready');
          return;
        }
        if (active) setState('provisioning');
        // Idempotent (the server gates on provisioned_at), so it is safe to run even if a
        // StrictMode twin effect or a racing mount also calls it — the second call seeds
        // nothing.
        await provisionPersonalMemex();
        knownReady = true;
        if (active) setState('ready');
      } catch {
        // Never wedge the app on a readiness hiccup — fall through to the app. The
        // seed endpoint is idempotent, so a later load simply retries the check.
        if (active) setState('ready');
      }
    })();

    return () => {
      active = false;
    };
  }, [emailVerified]);

  // Only a genuinely-unprovisioned new user (state==='provisioning') sees the blocker.
  // During the quick 'checking' GET we render the app, so provisioned users never flash
  // a loading screen on navigation.
  if (state === 'provisioning') return <GettingReadyBlocker />;
  return <>{children}</>;
}
