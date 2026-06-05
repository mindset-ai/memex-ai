import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { fetchMemexIssues } from '../api/client';
import { useDocChangeStream } from './useDocChangeStream';

/**
 * Open-issue count for the Issues nav badge (spec-158) — scoped to MY issues
 * (open issues on Specs assigned to the caller, the issues-list endpoint's
 * `scope=mine` default), matching the Issues page's own Mine default so the
 * badge and the landing view agree.
 *
 * Mirrors useDriftInboxCount: best-effort (any fetch error yields 0 so the
 * badge hides rather than erroring in the chrome), refreshes live on the SSE
 * bus, and re-fetches on a pathname change because AppShell stays mounted
 * across a client-side Memex switch. Pass `enabled = false` (e.g. on doc pages
 * where the sidebar is hidden) to skip the fetch entirely.
 */
export function useMyIssuesCount(enabled = true): number {
  const [count, setCount] = useState(0);
  // The active tenant lives in the URL path; re-fetch whenever it changes.
  const { pathname } = useLocation();

  const reload = useCallback(() => {
    if (!enabled) return;
    fetchMemexIssues({ scope: 'mine' })
      .then((items) => setCount(items.length))
      .catch(() => setCount(0));
    // `pathname` is a dependency so a Memex switch (client-side navigation,
    // AppShell stays mounted) re-fetches against the newly-selected tenant.
  }, [enabled, pathname]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Same global channel the Issues page rides — issues are registered/resolved
  // by agents (often via MCP), so the badge must react without a manual refresh.
  useDocChangeStream(null, reload);

  return count;
}
