import { useCallback, useEffect, useRef, useState } from 'react';
import { tenantBase } from '../api/http';
import type { PresentRow } from '../components/pulse/types';

/**
 * usePresence — the READ half of spec-122's presence plane (dec-4, ac-1/ac-5).
 *
 * Polls `GET /api/<ns>/<mx>/presence?ref=<spec>` for who's "here NOW" on one or
 * more specs and returns the merged set of present rows. Presence decays ~30s
 * server-side, so we re-poll on a short cadence to keep the live picture honest
 * (and to age workers out as their beats stop).
 *
 *   - The Pulse "Working now" zone passes EVERY active spec ref so it can show
 *     one line per active worker across the whole Memex (the presence endpoint
 *     is per-spec, so we fan out and merge).
 *   - The spec/AC ambient indicator passes a single ref.
 *
 * Best-effort: a failed poll leaves the last-known rows in place rather than
 * flickering the indicator empty.
 */

const POLL_INTERVAL_MS = 10_000;

export interface UsePresenceResult {
  /** Everyone "here" across the polled refs, most-recent beat first. */
  rows: PresentRow[];
  /** True until the first poll resolves. */
  loading: boolean;
}

export function usePresence(
  refs: string | readonly string[] | null | undefined,
  options: { intervalMs?: number } = {},
): UsePresenceResult {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const [rows, setRows] = useState<PresentRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Normalise to a stable comma-joined key so the effect only re-subscribes when
  // the actual set of refs changes, not on every parent render's new array.
  const refList = normaliseRefs(refs);
  const refKey = refList.join('|');

  const refListRef = useRef(refList);
  refListRef.current = refList;

  const poll = useCallback(async () => {
    const base = tenantBase();
    const list = refListRef.current;
    if (!base || list.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }
    try {
      const results = await Promise.all(
        list.map((ref) =>
          fetch(`${base}/presence?ref=${encodeURIComponent(ref)}`, {
            headers: authHeader(),
          })
            .then((res) => (res.ok ? (res.json() as Promise<PresentRow[]>) : []))
            .catch(() => [] as PresentRow[]),
        ),
      );
      // Merge + de-dupe across specs by (actorUserId, clientId, docId) — a worker
      // is one line per spec they're on.
      const byKey = new Map<string, PresentRow>();
      for (const set of results) {
        for (const r of set) {
          byKey.set(`${r.actorUserId}|${r.clientId}|${r.docId}`, r);
        }
      }
      const merged = [...byKey.values()].sort(
        (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
      );
      setRows(merged);
    } catch {
      // Keep the last-known rows on a transient failure.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void poll();
    const id = setInterval(() => {
      if (!cancelled) void poll();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // refKey captures the actual ref set; poll is stable.
  }, [refKey, intervalMs, poll]);

  return { rows, loading };
}

function normaliseRefs(
  refs: string | readonly string[] | null | undefined,
): string[] {
  if (!refs) return [];
  const arr = typeof refs === 'string' ? [refs] : [...refs];
  return [...new Set(arr.filter((r) => r && r.length > 0))].sort();
}

function authHeader(): Record<string, string> {
  const token =
    typeof window !== 'undefined'
      ? window.localStorage.getItem('memex-auth-token')
      : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
