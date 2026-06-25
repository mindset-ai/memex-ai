// Shared shapes + merge logic for the Pulse test-signal monitor (spec — test
// signals as a volume graphic, not Event-Log line noise).
//
// The server's GET /analytics/test-signal-pulse returns a gapless minute-bucketed
// baseline; the live SSE `test_event.created` stream tops it up between refetches.
// Both the right-column monitor and the Working-now counter render off the SAME
// merged view, so the merge lives here once.

/** One minute-bucket of test-emission volume, split by outcome. Mirrors the server. */
export interface TestSignalBucket {
  /** ISO-8601 UTC start of the minute bucket. */
  at: string;
  pass: number;
  fail: number;
  error: number;
}

/** The server payload from GET /analytics/test-signal-pulse. */
export interface TestSignalPulseDto {
  windowMinutes: number;
  buckets: TestSignalBucket[];
  totals: { pass: number; fail: number; error: number; total: number };
}

/** A live test-event, as distilled from an SSE `test_event` ChangeEvent. */
export interface LiveTestSignal {
  /** Event time (ISO). For live frames this is ~now. */
  at: string;
  status: 'pass' | 'fail' | 'error';
}

/** The merged, render-ready view the components consume. */
export interface MergedTestSignals {
  windowMinutes: number;
  /** Gapless minute buckets, oldest→newest, baseline + live folded in. */
  buckets: TestSignalBucket[];
  totals: { pass: number; fail: number; error: number; total: number };
  /** fail + error across the window — the "needs a look" number. */
  failing: number;
  /** Whole-percent of non-failing emissions (100 when the window is empty). */
  greenPct: number;
  /** Mean emissions per minute across the window. */
  ratePerMin: number;
  /** The tallest bucket's total — for normalising bar heights. */
  peak: number;
}

const EMPTY: TestSignalPulseDto = {
  windowMinutes: 60,
  buckets: [],
  totals: { pass: 0, fail: 0, error: 0, total: 0 },
};

/** Truncate an ISO timestamp to its minute bucket key (matches the server's date_trunc). */
function minuteKey(iso: string): string {
  // "2026-06-11T12:03:47.123Z" → "2026-06-11T12:03:00Z"
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCSeconds(0, 0);
  return d.toISOString().replace('.000Z', 'Z');
}

/**
 * Fold the live SSE signals onto the server baseline. A live signal lands in its
 * own minute bucket: an existing baseline bucket is incremented in place; a
 * newer minute (rolled over since the fetch) extends the tail and an equal count
 * of stale leading buckets is dropped so the window stays `windowMinutes` wide.
 *
 * Live events OLDER than the baseline's first bucket are ignored (the baseline
 * already covers that span, and counting them would double up after a refetch).
 */
export function mergeTestSignals(
  pulse: TestSignalPulseDto | null,
  live: readonly LiveTestSignal[],
): MergedTestSignals {
  const base = pulse ?? EMPTY;
  // Clone buckets so we never mutate the fetched payload.
  const byKey = new Map<string, TestSignalBucket>();
  const order: string[] = [];
  for (const b of base.buckets) {
    const copy = { ...b };
    byKey.set(b.at, copy);
    order.push(b.at);
  }
  const firstKey = order[0];

  for (const ev of live) {
    const key = minuteKey(ev.at);
    // Ignore events the baseline already spans (before its first bucket).
    if (firstKey && key < firstKey) continue;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { at: key, pass: 0, fail: 0, error: 0 };
      byKey.set(key, bucket);
      order.push(key);
    }
    bucket[ev.status] += 1;
  }

  // Re-sort (new tail keys may be out of order) and clamp to the window width.
  order.sort();
  const width = base.windowMinutes || order.length;
  const trimmed = order.slice(Math.max(0, order.length - width));
  const buckets = trimmed.map((k) => byKey.get(k)!);

  const totals = buckets.reduce(
    (a, b) => {
      a.pass += b.pass;
      a.fail += b.fail;
      a.error += b.error;
      a.total += b.pass + b.fail + b.error;
      return a;
    },
    { pass: 0, fail: 0, error: 0, total: 0 },
  );

  const failing = totals.fail + totals.error;
  const greenPct = totals.total === 0 ? 100 : Math.round((totals.pass / totals.total) * 100);
  const ratePerMin = buckets.length === 0 ? 0 : totals.total / buckets.length;
  const peak = buckets.reduce((m, b) => Math.max(m, b.pass + b.fail + b.error), 0);

  return {
    windowMinutes: base.windowMinutes,
    buckets,
    totals,
    failing,
    greenPct,
    ratePerMin,
    peak,
  };
}
