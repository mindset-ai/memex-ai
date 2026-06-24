import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useDocChangeStream } from './useDocChangeStream';

/**
 * Shared nav-badge count hook (spec-355 dry-11). Backs the drift-inbox and
 * my-issues badges, which were byte-identical except for the fetch they invoke.
 *
 * Behaviour (identical to the two former hooks):
 * - Best-effort: any fetch error yields 0 so the badge hides rather than
 *   surfacing an error in the chrome.
 * - Re-fetches whenever the URL pathname changes. The host (AppShell) stays
 *   mounted across a client-side Memex switch (the switcher uses `navigate()`,
 *   not a full reload), and `fetchItems` resolves the tenant from the URL path,
 *   so a path change MUST re-run the fetch against the newly-selected tenant —
 *   otherwise the badge keeps the prior Memex's stale count.
 * - Refreshes live on the SSE bus (drift/issues are mutated by the agent, often
 *   via MCP), so the badge reacts without a manual reload.
 * - Pass `enabled = false` (e.g. on doc pages where the sidebar is hidden) to
 *   skip the fetch entirely.
 *
 * `fetchItems` is the single axis of variation (spec-379 dec-1). It is held in
 * a ref refreshed each render so `reload` can keep its deps as
 * `[enabled, pathname]` — `reload`'s identity stays stable across renders and
 * the effect re-runs only on mount / enabled change / pathname change / SSE,
 * exactly as the former hooks did. Callers pass a module-stable thunk.
 */
export function useBadgeCount(
  fetchItems: () => Promise<{ length: number }>,
  enabled = true,
): number {
  const [count, setCount] = useState(0);
  // The active tenant lives in the URL path; re-fetch whenever it changes.
  const { pathname } = useLocation();

  // Hold the fetch in a ref so its identity never feeds the `reload` deps —
  // keeping `reload` stable across renders (matches the former hooks exactly).
  const fetchItemsRef = useRef(fetchItems);
  fetchItemsRef.current = fetchItems;

  const reload = useCallback(() => {
    if (!enabled) return;
    fetchItemsRef
      .current()
      .then((items) => setCount(items.length))
      .catch(() => setCount(0));
    // `pathname` is a dependency so a Memex switch (client-side navigation,
    // host stays mounted) re-fetches against the newly-selected tenant.
  }, [enabled, pathname]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Same global channel the inbox / issues boards use — entries are flagged or
  // resolved by the agent (often via MCP), so the badge must react without a
  // manual refresh.
  useDocChangeStream(null, reload);

  return count;
}
