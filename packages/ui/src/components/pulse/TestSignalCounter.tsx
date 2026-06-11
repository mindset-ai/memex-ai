// TestSignalCounter — the compact test-signal summary that sits in the
// Working-now zone (spec). A one-line live counter of verification traffic: the
// window total plus a "+N" badge that climbs as fresh SSE signals land between
// baseline refetches, then resets. It's the heartbeat that says "tests are
// flowing right now" next to who's working; the full sparkline lives in the
// right-column TestSignalsMonitor.

import { LiveDot } from './LiveDot';

export interface TestSignalCounterProps {
  /** Window total of test emissions (baseline + live). */
  total: number;
  /** Window length in minutes, for the label. */
  windowMinutes: number;
  /** fail + error across the window — surfaced inline when non-zero. */
  failing: number;
  /** Fresh live signals since the last baseline refetch — the "+N new" climb. */
  liveDelta: number;
}

export function TestSignalCounter({ total, windowMinutes, failing, liveDelta }: TestSignalCounterProps) {
  return (
    <div
      data-testid="test-signal-counter"
      className="flex-none flex items-center gap-2 mb-4 rounded-lg border border-edge-subtle bg-surface/40 px-3 py-2 text-xs"
    >
      <LiveDot live={liveDelta > 0} size="sm" className="text-status-success-text" />
      <span className="font-medium text-primary">Test signals</span>
      <span className="opacity-40">&middot;</span>
      <span className="tabular-nums text-secondary">
        {total.toLocaleString()} in last {windowMinutes}m
      </span>
      {liveDelta > 0 && (
        <span
          data-testid="test-signal-delta"
          className="inline-flex items-center rounded bg-status-success-text/10 px-1.5 py-0.5 font-semibold text-status-success-text tabular-nums animate-pulse-arrive"
        >
          +{liveDelta.toLocaleString()} new
        </span>
      )}
      {failing > 0 && (
        <span className="ml-auto inline-flex items-center gap-1 font-semibold text-status-danger-text tabular-nums">
          ⚠ {failing.toLocaleString()} failing
        </span>
      )}
    </div>
  );
}
