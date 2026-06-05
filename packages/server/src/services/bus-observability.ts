// Passive bus observability (doc-16 dec-3).
//
// Every 60s in production: snapshot the mutate() + bus counters, compute the
// delta against the previous snapshot, and emit a structured log line. On
// divergence — non-silent writes that produced fewer emits than expected —
// emit a WARN line tagged for alert pickup.
//
// The check is passive: no exceptions thrown, no requests blocked. The
// counters cost ~3 integer increments per mutate() call and one per bus.emit;
// the logger runs out-of-band on a setInterval.
//
// Sentry / external alerting wires onto the WARN log line — there's no SDK
// dependency in this file. The structured prefix `[BUS METRICS]` /
// `[BUS METRICS WARN]` is intended to be grep-friendly and machine-parseable.

import { bus, type ChangeAction } from "./bus.js";
import { getMutateMetrics } from "./mutate.js";

const SNAPSHOT_INTERVAL_MS = 60_000;

// Pulse (b-60). Read/activity actions ride the same bus as mutations, so they
// bump the bus `emits` counter — but they are NOT writes. Counting them as a
// distinct class keeps the write/emit divergence invariant honest (it's checked
// against mutation emits only) and surfaces read volume in the snapshot.
const READ_ACTIONS = ["viewed", "searched", "assessed", "called"] as const;
type ReadAction = (typeof READ_ACTIONS)[number];
const READ_ACTION_SET = new Set<ChangeAction>(READ_ACTIONS);

// Cumulative read-emit counters, populated by a permanent bus subscriber armed
// in startBusObservability(). Lives here (not on the bus) so the dispatch path
// stays untouched and this file owns the read/write classification end-to-end.
// Never reset in production; the snapshot consumer computes deltas.
const readEmitTotals: { total: number; byAction: Record<ReadAction, number> } = {
  total: 0,
  byAction: { viewed: 0, searched: 0, assessed: 0, called: 0 },
};
let readSubscription: (() => void) | null = null;

interface Snapshot {
  ts: number;
  writes: number;
  silentWrites: number;
  writesFailed: number;
  emits: number;
  // Pulse (b-60). Read-action emits (viewed/searched/assessed/called) carved out
  // of the total `emits` count above. `emits - reads` = mutation emits, which is
  // what the divergence invariant is checked against.
  reads: number;
  readsByAction: Record<ReadAction, number>;
  subscriberErrors: number;
  listenerCount: number;
}

function snap(): Snapshot {
  const m = getMutateMetrics();
  const b = bus.getMetrics();
  return {
    ts: Date.now(),
    writes: m.writes,
    silentWrites: m.silentWrites,
    writesFailed: m.writesFailed,
    emits: b.emits,
    reads: readEmitTotals.total,
    readsByAction: { ...readEmitTotals.byAction },
    subscriberErrors: b.subscriberErrors,
    listenerCount: b.listenerCount,
  };
}

interface Delta {
  windowMs: number;
  writes: number;
  silentWrites: number;
  writesFailed: number;
  emits: number;
  // Pulse (b-60). Read-emit count for the window + per-action breakdown.
  reads: number;
  readsByAction: Record<ReadAction, number>;
  subscriberErrors: number;
  listenerCount: number;
}

function delta(prev: Snapshot, curr: Snapshot): Delta {
  return {
    windowMs: curr.ts - prev.ts,
    writes: curr.writes - prev.writes,
    silentWrites: curr.silentWrites - prev.silentWrites,
    writesFailed: curr.writesFailed - prev.writesFailed,
    emits: curr.emits - prev.emits,
    reads: curr.reads - prev.reads,
    readsByAction: {
      viewed: curr.readsByAction.viewed - prev.readsByAction.viewed,
      searched: curr.readsByAction.searched - prev.readsByAction.searched,
      assessed: curr.readsByAction.assessed - prev.readsByAction.assessed,
      called: curr.readsByAction.called - prev.readsByAction.called,
    },
    subscriberErrors: curr.subscriberErrors - prev.subscriberErrors,
    listenerCount: curr.listenerCount,
  };
}

/**
 * The divergence invariant: every non-silent mutate() should emit ≥ 1 bus
 * event (and composite mutations emit more). Therefore in a healthy window:
 *
 *   mutationEmits >= writes - silentWrites
 *
 * where `mutationEmits = emits - reads`. Pulse (b-60) read actions
 * (viewed/searched/assessed/called) ride the same bus and inflate `emits`, so
 * the raw `emits` count must NOT be used here — it would mask a genuine
 * write-vs-emit gap (a real bypass could be hidden behind a wash of read
 * emits). Carving reads out keeps the invariant a faithful check on the
 * mutation dispatch path only.
 *
 * `reads` is clamped at the window's `emits` so a momentary snapshot skew
 * (reads counted just after `emits` was sampled) can't drive mutationEmits
 * negative and trip a spurious WARN.
 *
 * If `mutationEmits < writes - silentWrites` the bus dispatch path was bypassed
 * or monkey-patched. The check is intentionally simple — false-positives are
 * cheap (one log line); false-negatives (missed bypasses) are the actual cost
 * we want to avoid.
 */
export function checkDivergence(d: Delta): { ok: true } | { ok: false; missing: number } {
  const expected = d.writes - d.silentWrites;
  const mutationEmits = Math.max(0, d.emits - d.reads);
  if (mutationEmits < expected) {
    return { ok: false, missing: expected - mutationEmits };
  }
  return { ok: true };
}

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let lastSnapshot: Snapshot | null = null;

/**
 * Start the periodic observability logger. Idempotent — calling twice is a
 * no-op so unit tests that import this module don't accidentally double-arm
 * the interval. Returns the timer so the server-startup hook can `.unref()`
 * it (matching the invite-token / domain-verification cleanup pattern).
 */
export function startBusObservability(opts: { intervalMs?: number } = {}): ReturnType<typeof setInterval> | null {
  if (started) return timer;
  started = true;
  const interval = opts.intervalMs ?? SNAPSHOT_INTERVAL_MS;

  // Pulse (b-60). Arm a permanent, out-of-band subscriber that tallies read
  // emits by action. Permanent subscribers survive bus._reset() and aren't
  // counted by listenerCount — so this counter never perturbs the dispatch
  // path or the listener-count metric. Default-open subscription filtered to
  // the read actions only via the b-60 `actions` allowlist.
  readSubscription = bus.subscribe(
    { actions: READ_ACTIONS },
    (event) => {
      if (READ_ACTION_SET.has(event.action)) {
        readEmitTotals.total++;
        readEmitTotals.byAction[event.action as ReadAction]++;
      }
    },
    { permanent: true },
  );

  // Snapshot AFTER arming the subscriber so the first window's `reads` delta is
  // measured from a coherent baseline.
  lastSnapshot = snap();

  timer = setInterval(() => {
    try {
      const curr = snap();
      const d = delta(lastSnapshot!, curr);
      lastSnapshot = curr;

      // Skip-zero: a quiet window (no writes, no emits) doesn't warrant a log
      // line. Subscriber errors and divergence still log even on a quiet window.
      const quiet =
        d.writes === 0 &&
        d.silentWrites === 0 &&
        d.emits === 0 &&
        d.subscriberErrors === 0;

      const verdict = checkDivergence(d);

      if (!verdict.ok) {
        // Report against MUTATION emits (emits - reads), matching the invariant.
        // Read emits ride the same bus (Pulse b-60) and would otherwise mask the
        // gap, so they're excluded from the "saw" figure here.
        const mutationEmits = Math.max(0, d.emits - d.reads);
        // eslint-disable-next-line no-console
        console.warn(
          `[BUS METRICS WARN] divergence detected — expected emits>=${d.writes - d.silentWrites}, ` +
            `saw ${mutationEmits} (missing ${verdict.missing}). ` +
            JSON.stringify(d),
        );
        return;
      }

      if (d.subscriberErrors > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[BUS METRICS WARN] ${d.subscriberErrors} subscriber error(s) in window. ` +
            JSON.stringify(d),
        );
        return;
      }

      if (!quiet) {
        // eslint-disable-next-line no-console
        console.log(`[BUS METRICS] ${JSON.stringify(d)}`);
      }
    } catch (err) {
      // The logger must never crash the process. A periodic counter that
      // throws would be a worse failure mode than the issue it tried to
      // surface.
      // eslint-disable-next-line no-console
      console.error("[BUS METRICS] snapshot failed (passive — ignoring):", err);
    }
  }, interval);

  return timer;
}

/**
 * Test-only reset. Stops the timer and clears the started flag so a test
 * suite can re-arm with a tighter interval. Production code never calls this.
 */
export function _resetBusObservability(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
  lastSnapshot = null;
  // Pulse (b-60). Tear down the read-emit subscriber and zero the counters so a
  // re-armed test suite starts clean. Production never calls this.
  if (readSubscription) readSubscription();
  readSubscription = null;
  readEmitTotals.total = 0;
  readEmitTotals.byAction = { viewed: 0, searched: 0, assessed: 0, called: 0 };
}
