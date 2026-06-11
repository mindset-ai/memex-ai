// TestSignalsMonitor — the right-column "test signals" graphic (spec).
//
// Test emissions are a high-volume CI firehose (thousands/day) that used to
// flood the Event Log with unreadable per-run lines. They no longer land in the
// activity timeline at all; instead they surface HERE as an aggregate: a live
// minute-bucketed volume sparkline over the last hour, split pass/fail/error,
// with a headline rate + a loud failing callout. It gives the board a sense of
// real verification activity happening without the line noise.
//
// PRESENTATIONAL. The merged baseline+live view arrives via props; the Pulse
// page owns the hook + the live SSE buffer.

import { LiveDot } from './LiveDot';
import { useChartPalette } from '../insights/theme';
import type { MergedTestSignals } from './testSignals';

export interface TestSignalsMonitorProps {
  signals: MergedTestSignals;
  /** True until the first baseline fetch resolves. */
  loading?: boolean;
  /** A signal arrived very recently → breathe the live dot + pulse the last bar. */
  live?: boolean;
}

const SPARK_HEIGHT = 44; // px — the bar track height.

export function TestSignalsMonitor({ signals, loading = false, live = false }: TestSignalsMonitorProps) {
  const palette = useChartPalette();
  const { buckets, totals, failing, greenPct, ratePerMin, peak, windowMinutes } = signals;
  const hasData = totals.total > 0;
  const lastIdx = buckets.length - 1;

  return (
    <section
      data-testid="test-signals-monitor"
      className="flex-none rounded-lg border border-edge-subtle bg-surface/40 overflow-hidden mb-4"
    >
      {/* Header. */}
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs text-secondary border-b border-edge-subtle cursor-help"
        title="Test signals — the volume of automated test results (AC verifications) arriving from CI over the window, as a live rate and sparkline. Green is passing, red failing. It's a Memex-wide CI health signal, so it isn't shown under the 'just me' filter."
      >
        <LiveDot live={live && hasData} size="sm" className="text-status-success-text" />
        <span className="font-medium text-primary">Test signals</span>
        <span className="opacity-40">&middot;</span>
        <span className="tabular-nums">~{Math.round(ratePerMin)}/min</span>
        {failing > 0 ? (
          <span
            data-testid="test-signals-failing"
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.7rem] font-semibold text-status-danger-text bg-status-danger-text/10"
          >
            ⚠ {failing.toLocaleString()} failing
          </span>
        ) : hasData ? (
          <span className="ml-auto text-[0.7rem] text-status-success-text tabular-nums">
            {greenPct}% green
          </span>
        ) : null}
      </div>

      {/* Sparkline. */}
      <div className="px-3 pt-3 pb-2">
        {loading && !hasData ? (
          <div
            className="animate-pulse rounded bg-card-hover"
            style={{ height: SPARK_HEIGHT }}
            data-testid="test-signals-skeleton"
          />
        ) : !hasData ? (
          <div
            className="flex items-center justify-center text-xs text-muted"
            style={{ height: SPARK_HEIGHT }}
            data-testid="test-signals-empty"
          >
            No test signals in the last {windowMinutes} minutes.
          </div>
        ) : (
          <div
            className="flex items-end gap-px"
            style={{ height: SPARK_HEIGHT }}
            role="img"
            aria-label={`${totals.total} test emissions over the last ${windowMinutes} minutes, ${greenPct}% passing`}
          >
            {buckets.map((b, i) => {
              const total = b.pass + b.fail + b.error;
              const h = peak > 0 ? Math.max(total === 0 ? 0 : 2, (total / peak) * SPARK_HEIGHT) : 0;
              const seg = (n: number) => (total > 0 ? (n / total) * h : 0);
              const isLast = i === lastIdx;
              return (
                <div
                  key={b.at}
                  className={`flex-1 flex flex-col justify-end ${isLast && live ? 'animate-pulse' : ''}`}
                  style={{ minWidth: 1 }}
                  title={`${new Date(b.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${b.pass}✓ ${b.fail}✗ ${b.error}!`}
                >
                  {/* Stack: errors (amber) + fails (rose) grounded at the base, passes (emerald) above. */}
                  {b.pass > 0 && (
                    <span style={{ height: seg(b.pass), background: palette.testRun.pass, borderTopLeftRadius: 1, borderTopRightRadius: 1 }} />
                  )}
                  {b.fail > 0 && <span style={{ height: seg(b.fail), background: palette.testRun.fail }} />}
                  {b.error > 0 && <span style={{ height: seg(b.error), background: palette.testRun.error }} />}
                  {total === 0 && <span style={{ height: 1 }} className="bg-edge-subtle/40" />}
                </div>
              );
            })}
          </div>
        )}

        {/* Footer legend / totals. */}
        {hasData && (
          <div className="mt-2 flex items-center gap-3 text-[0.7rem] text-muted tabular-nums">
            <span className="inline-flex items-center gap-1">
              <Swatch color={palette.testRun.pass} /> {totals.pass.toLocaleString()}
            </span>
            <span className="inline-flex items-center gap-1">
              <Swatch color={palette.testRun.fail} /> {totals.fail.toLocaleString()}
            </span>
            <span className="inline-flex items-center gap-1">
              <Swatch color={palette.testRun.error} /> {totals.error.toLocaleString()}
            </span>
            <span className="ml-auto">{totals.total.toLocaleString()} in {windowMinutes}m</span>
          </div>
        )}
      </div>
    </section>
  );
}

function Swatch({ color }: { color: string }) {
  return <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />;
}
