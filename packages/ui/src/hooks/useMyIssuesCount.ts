import { fetchMemexIssues } from '../api/client';
import { useBadgeCount } from './useBadgeCount';

// Module-stable thunk so the reference handed to useBadgeCount never changes
// across renders (mirrors useDriftInboxCount passing the bare fetch fn).
const fetchMine = () => fetchMemexIssues({ scope: 'mine' });

/**
 * Open-issue count for the Issues nav badge (spec-158) — scoped to MY issues
 * (open issues on Specs assigned to the caller, the issues-list endpoint's
 * `scope=mine` default), matching the Issues page's own Mine default so the
 * badge and the landing view agree.
 *
 * Thin wrapper over the shared {@link useBadgeCount} (spec-355 dry-11):
 * best-effort (errors → 0), tenant-aware (re-fetches on a client-side Memex
 * switch), and live on the SSE bus. Pass `enabled = false` (e.g. on doc pages
 * where the sidebar is hidden) to skip the fetch entirely.
 */
export function useMyIssuesCount(enabled = true): number {
  return useBadgeCount(fetchMine, enabled);
}
