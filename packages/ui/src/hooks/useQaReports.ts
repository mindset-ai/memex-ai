// spec-260 (dec-5, dec-6) — client data layer for the workspace QA Reports feed.
//
// useQaReportsFeed mirrors usePulseHistory's keyset "Load More" shape over
// GET /api/<ns>/<mx>/qa-reports (newest-first; `since` = oldest loaded row's
// createdAt → strictly older page). useQaReportsUnreadCount is the per-user nav
// badge (GET …/qa-reports/unread), refreshed live off the SSE bus the way the
// Issues / Drift badges are. recordQaReportsView POSTs the "viewed now" marker
// (upserts last_viewed_at = now(), zeroing the badge) and announces it via a
// window event so the AppShell badge — a different component tree — zeroes
// without waiting for the next SSE tick.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { tenantBase, fetchWithRetry } from '../api/http';
import { useDocChangeStream } from './useDocChangeStream';

const DEFAULT_LIMIT = 50;

// Fired on window after a successful view-marker POST. The badge hook listens —
// the POST emits nothing on the server bus (it's per-user read-state, not an
// activity), so without this the badge would stay stale until the next event.
export const QA_REPORTS_VIEWED_EVENT = 'memex:qa-reports-viewed';

/** Wire shape of GET /api/<ns>/<mx>/qa-reports rows (server QaReportFeedRow). */
export interface QaReportFeedRow {
  id: string;
  docId: string;
  docHandle: string;
  docTitle: string;
  sectionType: string;
  version: number;
  title: string | null;
  content: string;
  actorUserId?: string | null;
  actorName?: string | null;
  actorKind: 'human' | 'mcp_agent' | 'in_app_agent' | 'system';
  channel: string | null;
  createdAt: string;
}

export interface UseQaReportsFeedResult {
  rows: QaReportFeedRow[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadOlder: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useQaReportsFeed(limit = DEFAULT_LIMIT): UseQaReportsFeedResult {
  const [rows, setRows] = useState<QaReportFeedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Latest-fetch-wins token + a rows mirror so loadOlder keeps a stable identity
  // (the usePulseHistory pattern).
  const reqToken = useRef(0);
  const rowsRef = useRef<QaReportFeedRow[]>([]);
  rowsRef.current = rows;
  const loadingOlderRef = useRef(false);

  const fetchPage = useCallback(
    async (since: string | undefined): Promise<QaReportFeedRow[]> => {
      const base = tenantBase();
      if (!base) {
        throw new Error('QA Reports requires tenant context (no namespace/memex in the URL).');
      }
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (since) params.set('since', since);
      const res = await fetchWithRetry(`${base}/qa-reports?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to load QA reports (${res.status})`);
      return (await res.json()) as QaReportFeedRow[];
    },
    [limit],
  );

  const refresh = useCallback(async () => {
    const myReq = ++reqToken.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(undefined);
      if (myReq !== reqToken.current) return; // superseded
      setRows(page);
      setHasMore(page.length >= limit);
    } catch (err) {
      if (myReq !== reqToken.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load QA reports');
    } finally {
      if (myReq === reqToken.current) setLoading(false);
    }
  }, [fetchPage, limit]);

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
      setHasMore(page.length >= limit);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load older QA reports');
    } finally {
      loadingOlderRef.current = false;
    }
  }, [fetchPage, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { rows, loading, error, hasMore, loadOlder, refresh };
}

export interface QaReportsViewReceipt {
  /** The marker just written. */
  lastViewedAt: string;
  /**
   * The marker BEFORE this view (null = first-ever view). This is the unread
   * boundary the badge was counting against — returned because opening the
   * page is exactly what resets the marker, so the page couldn't otherwise
   * know which rows were unread (ac-24).
   */
  previousLastViewedAt: string | null;
}

// One view-POST at a time. React StrictMode double-mounts effects in dev, so
// the page would otherwise fire TWO immediate POSTs — and the second receipt's
// "previous" marker would be the first POST's just-written now(), classifying
// every row as read and collapsing the lot (ac-24). Concurrent callers share
// the in-flight call; it clears on settle so a later real revisit POSTs fresh.
let viewInFlight: Promise<QaReportsViewReceipt | null> | null = null;

/**
 * Record that the current user viewed the QA Reports feed now. Upserts the
 * per-(user, memex) last_viewed_at marker server-side, broadcasts
 * QA_REPORTS_VIEWED_EVENT so the nav badge zeroes immediately, and returns the
 * view receipt (incl. the PREVIOUS marker). Returns null when the marker can't
 * be written (no tenant context, anonymous viewer, network failure) — the
 * caller falls back to collapsed rows.
 */
export function recordQaReportsView(): Promise<QaReportsViewReceipt | null> {
  if (viewInFlight) return viewInFlight;
  viewInFlight = (async () => {
    const base = tenantBase();
    if (!base) return null;
    try {
      const res = await fetchWithRetry(`${base}/qa-reports/view`, { method: 'POST' });
      if (!res.ok) return null;
      window.dispatchEvent(new Event(QA_REPORTS_VIEWED_EVENT));
      return (await res.json()) as QaReportsViewReceipt;
    } catch {
      // Best-effort: a failed marker write leaves the badge stale, never breaks the page.
      return null;
    } finally {
      viewInFlight = null;
    }
  })();
  return viewInFlight;
}

/**
 * Per-user unread QA-report count for the nav badge (dec-6): the number of
 * reports generated since this user last viewed the feed — ALL reports,
 * own-agent included. Best-effort like useDriftInboxCount: errors yield 0 so
 * the badge hides rather than erroring in the chrome. Live via the SSE bus
 * (a new qa_report section emits section.created), re-fetched on Memex switch
 * (pathname), and zeroed on the page's view-marker broadcast.
 */
export function useQaReportsUnreadCount(enabled = true): number {
  const [count, setCount] = useState(0);
  const { pathname } = useLocation();

  const reload = useCallback(() => {
    if (!enabled) return;
    const base = tenantBase();
    if (!base) {
      setCount(0);
      return;
    }
    fetchWithRetry(`${base}/qa-reports/unread`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { count: number };
        setCount(body.count ?? 0);
      })
      .catch(() => setCount(0));
  }, [enabled, pathname]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Zero immediately when the QA Reports page records a view (same tab).
  useEffect(() => {
    const onViewed = () => setCount(0);
    window.addEventListener(QA_REPORTS_VIEWED_EVENT, onViewed);
    return () => window.removeEventListener(QA_REPORTS_VIEWED_EVENT, onViewed);
  }, []);

  // A freshly written report rides the std-8 bus as a section event — refresh
  // the count without a reload (the Issues/Drift badge pattern).
  useDocChangeStream(null, reload);

  return count;
}
