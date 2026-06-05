// spec-111 t-8 (ac-5) — the non-member landing for a PRIVATE Memex.
//
// The server returns 404 for a private Memex read by a non-member/anonymous
// caller (std-7 — indistinguishable from "doesn't exist", no enumeration leak).
// The React UI surfaces that 404 as this clean landing rather than a raw error:
// "This Memex is private" + a single [Sign in] CTA. There is NO request-access
// flow yet (deferred to a future Spec) — the only forward action is to sign in
// (an org member who signs in will then see the Memex normally).
//
// Rendered by the route/data layer when a Memex read 404s for the current
// caller. Kept presentational + dependency-light so it can be dropped in from
// either an error boundary or an explicit visibility check.

import { buildSignupUrl } from '../utils/publicSignup';

export function PrivateMemexLanding({
  /** Path (+ query) to return to after signing in. Defaults to the current URL. */
  returnTo,
}: {
  returnTo?: string;
} = {}) {
  const target =
    returnTo ??
    (typeof window !== 'undefined'
      ? window.location.pathname + window.location.search
      : '/');
  const signInHref = buildSignupUrl(target);

  return (
    <div
      className="min-h-screen bg-page flex items-center justify-center p-6"
      data-testid="private-memex-landing"
    >
      <div className="max-w-md w-full text-center">
        <div className="mb-6 flex justify-center">
          <svg
            className="w-12 h-12 text-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
            />
          </svg>
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-heading mb-2">
          This Memex is private
        </h1>
        <p className="text-sm text-secondary mb-6">
          Only members of this org can view it. If you have access, sign in to
          continue.
        </p>
        <a
          href={signInHref}
          className="inline-flex items-center justify-center px-4 py-2 rounded-lg text-sm font-medium bg-btn-primary hover:bg-btn-primary-hover text-white transition-colors"
          data-testid="private-memex-signin"
        >
          Sign in
        </a>
      </div>
    </div>
  );
}
