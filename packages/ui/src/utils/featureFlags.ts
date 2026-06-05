// spec-146 t-2: the reusable client primitive for the server-driven feature-hide
// list (dec-1 / Option B). `hiddenFeatures` rides on the session payload
// (`HIDDEN_FEATURES` env → /api/auth/me → AuthContext); these predicates answer
// "is feature X hidden?" for the nav filter (t-3) and the route gate (t-4), and
// for the sibling specs (spec-147 hides pause, spec-148 hides Pulse).
//
// Pure + framework-free so it can be unit-tested without React and called from
// non-hook contexts (e.g. App.tsx route registration). Fail-open by design: a
// null session, a missing field (a session cached before this shipped), or an
// unknown slug all mean "not hidden". Never throws.

import type { SessionPayload } from '../api/client';

/** The hidden-feature slugs for this session, or [] when there's no session/field. */
export function getHiddenFeatures(session: SessionPayload | null): string[] {
  return session?.hiddenFeatures ?? [];
}

/** True only when `slug` is in the session's hidden list; false otherwise (fail-open). */
export function isFeatureHidden(session: SessionPayload | null, slug: string): boolean {
  return getHiddenFeatures(session).includes(slug);
}
