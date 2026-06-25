// spec-406 (dec-5): per-spec task velocity — grouped daily bars of tasks
// created / started / completed. A Nivo chart, so it consumes the shared theme
// + palette and is registered in CHART_FILES (std-27 cl-14).

import { ResponsiveBar } from '@nivo/bar';
import type { SpecTaskVelocityPoint } from '../../api/insights';
import { TOOLTIP_STYLE, insightsTheme, integerTicks, shortDate, useChartPalette } from './theme';

interface Props {
  points: SpecTaskVelocityPoint[];
}

const SERIES = ['created', 'started', 'completed'] as const;

export function SpecTaskVelocityChart({ points }: Props) {
  const palette = useChartPalette();
  // Reserved hues: created = the accent (intent), started = build (in flight),
  // completed = done (verified green).
  const colorFor: Record<(typeof SERIES)[number], string> = {
    created: palette.accent,
    started: palette.phase.build,
    completed: palette.phase.done,
  };

  if (points.length === 0 || points.every((p) => p.created + p.started + p.completed === 0)) {
    return (
      <div
        data-testid="spec-task-velocity-chart"
        className="h-64 flex items-center justify-center text-sm text-secondary"
      >
        No tasks yet — velocity unlocks once this spec has build tasks.
      </div>
    );
  }

  const max = Math.max(1, ...points.map((p) => Math.max(p.created, p.started, p.completed)));

  return (
    <div data-testid="spec-task-velocity-chart" className="h-64">
      <ResponsiveBar
        data={points as unknown as Array<Record<string, string | number>>}
        keys={[...SERIES]}
        indexBy="day"
        groupMode="grouped"
        margin={{ top: 16, right: 16, bottom: 36, left: 32 }}
        padding={0.2}
        innerPadding={1}
        colors={(d) => colorFor[d.id as (typeof SERIES)[number]]}
        theme={insightsTheme}
        enableLabel={false}
        axisLeft={{ tickValues: integerTicks(max) }}
        gridYValues={integerTicks(max)}
        axisBottom={{
          format: (v) => shortDate(String(v)),
          tickRotation: points.length > 8 ? -40 : 0,
        }}
        tooltip={({ id, value, indexValue }) => (
          <div className="text-xs rounded-lg px-3 py-2" style={TOOLTIP_STYLE}>
            <span className="font-medium">{value}</span> {String(id)} · {shortDate(String(indexValue))}
          </div>
        )}
        animate
      />
    </div>
  );
}
