// spec-179 (ac-2): cumulative specs stacked by current phase. A Nivo line
// chart with stacked linear y-scale + filled areas IS a stacked area chart
// with a real time axis — phase colors match the kanban lane families
// (insights/theme.ts).
//
// Honesty caveat (spec-179 s-2 / Design): each spec is stacked by the phase
// it is in TODAY, keyed by its creation date — not a historical
// reconstruction. The subtitle below the title carries that until
// status_changed history (ac-5) accumulates enough to reconstruct truly.

import { ResponsiveLine } from '@nivo/line';
import type { SpecsByPhasePoint } from '../../api/client';
import { PHASE_ORDER, TOOLTIP_STYLE, insightsTheme, integerTicks, phaseLabel, shortDate, useChartPalette, type Phase } from './theme';

interface Props {
  points: SpecsByPhasePoint[];
}

export function SpecsByPhaseChart({ points }: Props) {
  const palette = useChartPalette();
  // Series bottom-up: done first so the completed foundation sits under the
  // in-flight phases and draft floats on top (mirrors the offline prototype).
  const stackOrder = [...PHASE_ORDER].reverse();
  const data = stackOrder.map((phase) => ({
    id: phase,
    data: points.map((p) => ({ x: p.day, y: p[phase] })),
  }));
  const every = Math.max(1, Math.ceil(points.length / 8));
  const tickValues = points.filter((_, i) => i % every === 0).map((p) => p.day);
  const yTicks = integerTicks(
    Math.max(...points.map((p) => PHASE_ORDER.reduce((s, ph) => s + p[ph], 0)), 1),
  );

  return (
    <div data-testid="specs-by-phase-chart" className="h-72">
      <ResponsiveLine
        data={data}
        xScale={{ type: 'point' }}
        yScale={{ type: 'linear', min: 0, max: 'auto', stacked: true }}
        margin={{ top: 16, right: 16, bottom: 36, left: 40 }}
        colors={(serie) => palette.phase[serie.id as Phase]}
        theme={insightsTheme}
        enableArea
        // Translucent fills + full-strength 2px edges — layered glass, not
        // solid slabs. The stacked bands stay distinguishable by their crisp
        // top lines even where the fills blend.
        areaOpacity={0.3}
        lineWidth={2}
        enablePoints={false}
        curve="monotoneX"
        axisBottom={{ tickSize: 0, tickPadding: 8, tickValues, format: (v) => shortDate(String(v)) }}
        axisLeft={{ tickSize: 0, tickPadding: 8, tickValues: yTicks }}
        gridYValues={yTicks}
        enableGridX={false}
        enableSlices="x"
        sliceTooltip={({ slice }) => (
          <div
            className="text-xs rounded-lg px-3 py-2"
            style={TOOLTIP_STYLE}
          >
            <div className="font-medium mb-1">{shortDate(String(slice.points[0]?.data.x))}</div>
            {slice.points
              .slice()
              .reverse()
              .map((pt) => (
                <div key={pt.id} className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: pt.seriesColor }} />
                  <span>{phaseLabel(String(pt.seriesId))}</span>
                  <span className="ml-auto font-medium">{String(pt.data.y)}</span>
                </div>
              ))}
          </div>
        )}
        animate
      />
    </div>
  );
}
