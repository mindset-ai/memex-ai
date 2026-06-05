// spec-146 t-2: React-hook wrappers over the pure feature-hide predicates
// (utils/featureFlags). They read `hiddenFeatures` off the session via
// AuthContext so call sites re-render when a background session refresh updates
// the list (ac-9). The nav filter (t-3) uses `useIsFeatureHidden`; the route
// gate (t-4) calls the pure `isFeatureHidden(session, slug)` directly.

import { useAuth } from '../components/AuthContext';
import { getHiddenFeatures, isFeatureHidden } from '../utils/featureFlags';

/** True when `slug` is hidden in the current session; false otherwise (fail-open). */
export function useIsFeatureHidden(slug: string): boolean {
  const { session } = useAuth();
  return isFeatureHidden(session, slug);
}

/** The hidden-feature slugs for the current session, or [] when none. */
export function useHiddenFeatures(): string[] {
  const { session } = useAuth();
  return getHiddenFeatures(session);
}
