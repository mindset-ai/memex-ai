import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { fetchDriftInbox } from '../api/client';
import { useDocChangeStream } from './useDocChangeStream';

/**
 * Open standards drift + proposal count for the nav badge (b-63).
 *
 * Best-effort: any fetch error (e.g. no tenant resolvable on a flat route)
 * yields 0 so the badge simply hides rather than surfacing an error in the
 * chrome. Refreshes live on the SSE bus, so flagging or resolving drift updates
 * the badge without a reload. Pass `enabled = false` (e.g. on doc pages where
 * the sidebar is hidden) to skip the fetch entirely.
 *
 * `fetchDriftInbox` resolves the tenant from the URL path (`tBase()`), so the
 * count is implicitly scoped to the current Memex. But AppShell — where this
 * hook lives — stays mounted across a Memex switch (the switcher uses client-
 * side `navigate()`, not a full reload), so we MUST re-fetch when the active
 * tenant changes. We key the refetch on the location pathname: switching
 * `barrie/personal` → `Main` changes the path, which re-runs `reload()` against
 * the new tenant base and updates the badge (e.g. 3 → 0). Without this the badge
 * would keep the prior Memex's stale count even though the page body is empty.
 */
export function useDriftInboxCount(enabled = true): number {
  const [count, setCount] = useState(0);
  // The active tenant lives in the URL path; re-fetch whenever it changes.
  const { pathname } = useLocation();

  const reload = useCallback(() => {
    if (!enabled) return;
    fetchDriftInbox()
      .then((items) => setCount(items.length))
      .catch(() => setCount(0));
    // `pathname` is a dependency so a Memex switch (client-side navigation,
    // AppShell stays mounted) re-fetches against the newly-selected tenant.
  }, [enabled, pathname]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Same global channel the inbox + standards boards use — drift is flagged by
  // the agent (often via MCP), so the badge must react without a manual refresh.
  useDocChangeStream(null, reload);

  return count;
}
