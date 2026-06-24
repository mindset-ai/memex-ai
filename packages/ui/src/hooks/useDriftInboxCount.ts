import { fetchDriftInbox } from '../api/client';
import { useBadgeCount } from './useBadgeCount';

/**
 * Open standards drift + proposal count for the nav badge (b-63).
 *
 * Thin wrapper over the shared {@link useBadgeCount} (spec-355 dry-11): the
 * count is the number of drift-inbox items for the current tenant. Best-effort
 * (errors → 0), tenant-aware (re-fetches on a client-side Memex switch), and
 * live on the SSE bus. Pass `enabled = false` (e.g. on doc pages where the
 * sidebar is hidden) to skip the fetch entirely.
 *
 * `fetchDriftInbox` is a module-level function, so the thunk passed here is
 * stable across renders.
 */
export function useDriftInboxCount(enabled = true): number {
  return useBadgeCount(fetchDriftInbox, enabled);
}
