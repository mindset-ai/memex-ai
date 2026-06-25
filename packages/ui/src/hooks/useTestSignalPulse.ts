import { useCallback, useEffect, useRef, useState } from 'react';
import { tenantBase, fetchWithRetry } from '../api/http';
import type { TestSignalPulseDto } from '../components/pulse/testSignals';

/**
 * useTestSignalPulse — the historical baseline for the Pulse test-signal monitor.
 *
 * Fetches `GET /api/<ns>/<mx>/analytics/test-signal-pulse?windowMinutes=N` — a
 * gapless minute-bucketed count of test emissions over the last N minutes, split
 * pass/fail/error. The Pulse page tops this up live from the SSE `test_event`
 * stream (mergeTestSignals); this hook owns ONLY the periodic baseline refetch
 * that corrects drift and absorbs the live buffer.
 *
 * `fetchedAt` bumps on every successful refetch — the page watches it to clear
 * its accumulated live buffer so a signal already folded into the new baseline
 * isn't also counted live (no double-count).
 */

const REFRESH_INTERVAL_MS = 45_000;

export interface UseTestSignalPulseResult {
  pulse: TestSignalPulseDto | null;
  loading: boolean;
  error: string | null;
  /** Monotonic marker (ms) of the latest successful fetch; changes → live buffer should reset. */
  fetchedAt: number;
  /** Force a baseline refetch (e.g. on SSE reconnect). */
  refresh: () => Promise<void>;
}

export function useTestSignalPulse(windowMinutes = 60): UseTestSignalPulseResult {
  const [pulse, setPulse] = useState<TestSignalPulseDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);

  // Only the latest request may write state (guards overlapping refetches).
  const reqToken = useRef(0);

  const refresh = useCallback(async () => {
    const myReq = ++reqToken.current;
    setError(null);
    try {
      const base = tenantBase();
      if (!base) throw new Error('Test signals require tenant context.');
      const res = await fetchWithRetry(
        `${base}/analytics/test-signal-pulse?windowMinutes=${windowMinutes}`,
      );
      if (!res.ok) throw new Error(`Failed to load test signals (${res.status})`);
      const dto = (await res.json()) as TestSignalPulseDto;
      if (myReq !== reqToken.current) return; // superseded
      setPulse(dto);
      setFetchedAt(Date.now());
    } catch (err) {
      if (myReq !== reqToken.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load test signals');
    } finally {
      if (myReq === reqToken.current) setLoading(false);
    }
  }, [windowMinutes]);

  // Initial fetch + periodic drift correction.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { pulse, loading, error, fetchedAt, refresh };
}
