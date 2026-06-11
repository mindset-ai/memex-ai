// VitalsStrip — spec-255: the thin "vital signs" band at the top of Pulse.
// Graphics where the page had none: a single-series tempo sparkline (meaningful
// events/min, ~30min) and an "active now" presence indicator (from the presence
// plane, split human vs agent). PRESENTATIONAL — rows arrive via props.

import { useMemo } from 'react';
import { useChartPalette } from '../insights/theme';
import { activeNow, tempoSeries } from './pulseDerive';
import type { ActivityRow, PresentRow } from './types';

export interface VitalsStripProps {
  /** Everyone present right now (presence plane), already merged. */
  present: PresentRow[];
  /** Persisted activity rows (history), for the tempo sparkline. */
  activity: ActivityRow[];
  /** Clock override for tests; defaults to Date.now(). */
  now?: number;
  /** Sparkline window in minutes. */
  windowMin?: number;
}

const SPARK_HEIGHT = 28; // px
const EMPTY_BAR = 'rgba(148, 163, 184, 0.30)';

export function VitalsStrip({ present, activity, now, windowMin = 30 }: VitalsStripProps) {
  const palette = useChartPalette();
  const clock = now ?? Date.now();

  const counts = useMemo(() => activeNow(present), [present]);
  const series = useMemo(
    () => tempoSeries(activity, clock, windowMin),
    [activity, clock, windowMin],
  );
  const total = series.reduce((a, b) => a + b, 0);
  const peak = Math.max(1, ...series);
  const perMin = Math.round(total / windowMin);

  return (
    <section
      data-testid="vitals-strip"
      className="flex-none flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-edge-subtle bg-surface/40 px-3 py-2 mb-4"
    >
      {/* Tempo — ONE aggregate series (dec-5). */}
      <div className="flex items-center gap-2">
        <span className="text-[0.65rem] uppercase tracking-wide text-muted">Tempo</span>
        <div
          data-testid="tempo-sparkline"
          className="flex items-end gap-px"
          style={{ height: SPARK_HEIGHT, width: windowMin * 3 }}
          role="img"
          aria-label={`${total} meaningful events over the last ${windowMin} minutes`}
        >
          {series.map((n, i) => (
            <span
              key={i}
              className="flex-1"
              style={{
                minWidth: 1,
                height: Math.max(n === 0 ? 1 : 2, (n / peak) * SPARK_HEIGHT),
                background: n === 0 ? EMPTY_BAR : palette.accent,
                borderRadius: 1,
              }}
            />
          ))}
        </div>
        <span className="text-xs text-secondary tabular-nums">{perMin}/min</span>
      </div>

      {/* Active now — from the presence plane, split human vs agent. */}
      <div data-testid="vitals-active-now" className="flex items-center gap-2 text-xs">
        <span className="text-[0.65rem] uppercase tracking-wide text-muted">Active now</span>
        <span className="inline-flex items-center gap-1 font-medium text-primary">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: counts.total > 0 ? palette.testRun.pass : EMPTY_BAR }}
          />
          {counts.total}
        </span>
        <span className="text-muted tabular-nums">
          {counts.agents} {counts.agents === 1 ? 'agent' : 'agents'} &middot;{' '}
          {counts.humans} {counts.humans === 1 ? 'human' : 'humans'}
        </span>
      </div>
    </section>
  );
}
