// spec-111 t-8 — the anonymous → signed-in conversion loop for public Memexes.
//
// An anonymous visitor reading a public Memex clicks "Sign up". We send them to
// the auth surface with a `returnTo` pointing back at the exact public-Memex URL
// they're on. After they complete signup, `AuthContext.acceptSession` honours
// `?returnTo=` (same-origin only, via `isSafeReturnUrl`) and bounces them back —
// now signed in. On that return visit the server records a `user_memex_access`
// pin (t-3/t-6), so the public Memex auto-appears in their "Visited" list and
// the personal Memex created during signup is already theirs.
//
// We carry `returnTo` as a query param on `/login` (the LoginScreen path). The
// LoginScreen drives both sign-in AND sign-up (identifier-first), so the same
// URL covers ac-7's "starts the signup flow" requirement.

const RETURN_TO_PARAM = 'returnTo';

/**
 * Build the `/login?returnTo=<current public Memex path>` URL for the "Sign up"
 * button. Pass the current pathname (+ optional search/hash) so the visitor
 * lands back exactly where they were after authenticating.
 */
export function buildSignupUrl(currentPathWithQuery: string): string {
  const returnTo = currentPathWithQuery || '/';
  return `/login?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`;
}

/** Read the `returnTo` query param from a search string (e.g. `location.search`). */
export function readReturnTo(search: string): string | null {
  try {
    const params = new URLSearchParams(search);
    return params.get(RETURN_TO_PARAM);
  } catch {
    return null;
  }
}
