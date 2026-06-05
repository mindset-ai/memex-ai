// spec-111 t-8 — the read-only / anonymous chrome for public Memexes.
//
//   <PublicAuthButtons/> — anonymous top-nav controls, shown in place of the
//                       Memex switcher when there's no session. Two buttons side
//                       by side ("Log in" + "Sign up"). Both start the auth flow
//                       with a `returnTo` to the current public Memex; AuthContext
//                       bounces back here signed-in (ac-7), and the server pins
//                       the visited Memex on that return read (ac-8).
//
//   <ReadOnlyBadge/>  — sidebar badge shown to a signed-in NON-member browsing a
//                       public Memex (a `source: 'visited'` row). Signals that
//                       every edit/create control is intentionally absent.

import { buildSignupUrl } from '../utils/publicSignup';

// Anonymous auth controls for a public Memex. Two buttons side by side: a
// secondary "Log in" and a primary "Sign up". Both are <a> (full document load,
// not a Router <Link>) pointing at the identifier-first `/login?returnTo=…`
// page, which drives sign-in AND sign-up — the labels just frame intent for
// returning vs new visitors. AuthContext honours the `returnTo` and bounces the
// visitor back to this public Memex, now signed in.
export function PublicAuthButtons({
  /** Current path (+ query) to return to after auth. Defaults to the live URL. */
  returnTo,
}: {
  returnTo?: string;
} = {}) {
  const target =
    returnTo ??
    (typeof window !== 'undefined'
      ? window.location.pathname + window.location.search
      : '/');
  const href = buildSignupUrl(target);
  return (
    <div className="flex items-center gap-2" data-testid="public-auth-buttons">
      <a
        href={href}
        data-testid="public-login-button"
        className="flex-1 inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-sm font-medium border border-edge text-secondary transition-colors hover:text-primary hover:bg-card-hover"
      >
        Log in
      </a>
      <a
        href={href}
        data-testid="public-signup-button"
        className="flex-1 inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-sm font-medium bg-btn-primary hover:bg-btn-primary-hover text-white transition-colors"
      >
        Sign up
      </a>
    </div>
  );
}

// Read-only badge for the signed-in non-member case. The globe + "Read-only"
// text mirror the public-Memex header badge so the two read consistently.
export function ReadOnlyBadge() {
  return (
    <div
      data-testid="readonly-sidebar-badge"
      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-card-hover text-secondary border border-edge"
      title="You're viewing this public Memex in read-only mode"
    >
      <span aria-hidden="true">🌐</span>
      <span>Read-only</span>
    </div>
  );
}
