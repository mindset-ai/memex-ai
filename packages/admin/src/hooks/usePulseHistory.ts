import { useCallback, useEffect, useRef, useState } from 'react';
import { tenantBase, fetchWithRetry } from '../api/http';
import type { ActivityRow } from '../components/pulse/types';

/**
 * usePulseHistory — the historical half of the Pulse (b-60) dashboard.
 *
 * Fetches `GET /api/<ns>/<mx>/activity` (newest-first) for the current Memex,
 * with optional filters, and pages BACKWARD ("load older") via the server's
 * exclusive `since` keyset boundary — passing the oldest currently-loaded row's
 * `createdAt` so each page strictly precedes the last.
 *
 * Tenancy + auth follow the existing admin conventions:
 *   - `tenantBase()` yields `/api/<ns>/<mx>` from the browser path (falling back
 *     to the cached session on flat pages). The namespace/memex are NOT passed
 *     in — they come from the URL, same as every other tenant-scoped call.
 *   - `fetchWithRetry` auto-attaches the stored bearer token and retries 502/503.
 *
 * `hasMore` is inferred from page fullness: a page returning exactly `limit`
 * rows MIGHT have more behind it, so we keep `loadOlder` enabled; a short page
 * means we've reached the tail.
 */

const DEFAULT_LIMIT = 50;

export interface PulseHistoryFilters {
  /** Filter to one human actor (user UUID). */
  actorUserId?: string;
  /** Filter to one originating client (opaque id). */
  clientId?: string;
  /** Filter to activity touching one Spec — accepts a `spec-N` / legacy `b-N` handle or a UUID. */
  briefId?: string;
  /** Page size. Server default 50, hard-capped at 200. */
  limit?: number;
}

export interface UsePulseHistoryResult {
  /** Loaded rows, newest-first. Append-on-load-older keeps this ordered. */
  rows: ActivityRow[];
  /** True while the initial fetch (or a filter-triggered refetch) is in flight. */
  loading: boolean;
  /** Last fetch error message, or null. */
  error: string | null;
  /** Whether another older page is likely available (last page was full). */
  hasMore: boolean;
  /** Fetch the next older page using the oldest loaded row's createdAt as `since`. */
  loadOlder: () => Promise<void>;
  /** Re-fetch the first page from scratch (e.g. after an SSE reconnect). */
  refresh: () => Promise<void>;
}

function buildQuery(
  filters: PulseHistoryFilters,
  since?: string,
): string {
  const params = new URLSearchParams();
  const limit = filters.limit ?? DEFAULT_LIMIT;
  params.set('limit', String(limit));
  if (filters.actorUserId) params.set('actorUserId', filters.actorUserId);
  if (filters.clientId) params.set('clientId', filters.clientId);
  if (filters.briefId) params.set('briefId', filters.briefId);
  if (since) params.set('since', since);
  return params.toString();
}

export function usePulseHistory(
  filters: PulseHistoryFilters = {},
): UsePulseHistoryResult {
  const { actorUserId, clientId, briefId, limit } = filters;
  const pageLimit = limit ?? DEFAULT_LIMIT;

  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Guard against overlapping/older in-flight requests writing stale results:
  // each fetch bumps the token and only the latest wins.
  const reqToken = useRef(0);
  // Mirror the latest rows so loadOlder can read the current tail without
  // depending on `rows` (keeps loadOlder identity stable).
  const rowsRef = useRef<ActivityRow[]>([]);
  rowsRef.current = rows;
  const loadingOlderRef = useRef(false);

  async function fetchPage(since: string | undefined): Promise<ActivityRow[]> {
    const base = tenantBase();
    if (!base) {
      throw new Error(
        'Pulse history requires tenant context (no namespace/memex in the URL).',
      );
    }
    const qs = buildQuery({ actorUserId, clientId, briefId, limit }, since);
    const res = await fetchWithRetry(`${base}/activity?${qs}`);
    if (!res.ok) {
      throw new Error(`Failed to load activity (${res.status})`);
    }
    return (await res.json()) as ActivityRow[];
  }

  const refresh = useCallback(async () => {
    const myReq = ++reqToken.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(undefined);
      if (myReq !== reqToken.current) return; // superseded
      setRows(page);
      setHasMore(page.length >= pageLimit);
    } catch (err) {
      if (myReq !== reqToken.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load activity');
    } finally {
      if (myReq === reqToken.current) setLoading(false);
    }
    // fetchPage closes over the filter values; refresh is re-created when they
    // change (deps below), which is exactly when we want a fresh first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorUserId, clientId, briefId, pageLimit]);

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const current = rowsRef.current;
    const oldest = current[current.length - 1];
    if (!oldest) return; // nothing loaded yet — refresh covers the first page
    loadingOlderRef.current = true;
    setError(null);
    try {
      const page = await fetchPage(oldest.createdAt);
      setRows((prev) => [...prev, ...page]);
      setHasMore(page.length >= pageLimit);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load older activity');
    } finally {
      loadingOlderRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorUserId, clientId, briefId, pageLimit]);

  // (Re)load the first page whenever the filter set changes.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { rows, loading, error, hasMore, loadOlder, refresh };
}
