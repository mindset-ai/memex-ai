// spec-179 (ac-1): the Insights hero — specs created per day (bars) with the
// cumulative total drawn as a custom polyline layer on its own linear scale.
// Nivo has no combo chart; the layer receives the positioned bars and the
// chart's inner box, which is everything a cumulative overlay needs.

import { ResponsiveBar, type BarCustomLayerProps } from '@nivo/bar';
import type { SpecsOverTimePoint } from '../../api/client';
import { insightsTheme, integerTicks, shortDate, useChartPalette } from './theme';

interface Props {
  points: SpecsOverTimePoint[];
}

interface Datum {
  day: string;
  created: number;
  cumulative: number;
  [key: string]: string | number;
}

function CumulativeLineLayer({
  bars,
  innerHeight,
  accent,
}: BarCustomLayerProps<Datum> & { accent: string }) {
  if (bars.length === 0) return null;
  const max = Math.max(...bars.map((b) => b.data.data.cumulative), 1);
  const pts = bars
    .slice()
    .sort((a, b) => a.x - b.x)
    .map((b) => {
      const x = b.x + b.width / 2;
      const y = innerHeight - (b.data.data.cumulative / max) * innerHeight;
      return { x, y };
    });
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <g pointerEvents="none">
      <path d={d} fill="none" stroke={accent} strokeWidth={2.5} strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r={3.5} fill={accent} />
    </g>
  );
}

export function SpecsOverTimeChart({ points }: Props) {
  const palette = useChartPalette();
  const data: Datum[] = points.map((p) => ({ ...p }));
  const total = points.length ? points[points.length - 1].cumulative : 0;
  // Thin the date axis: aim for ~10 labelled ticks regardless of range.
  const every = Math.max(1, Math.ceil(points.length / 10));
  const tickValues = points.filter((_, i) => i % every === 0).map((p) => p.day);
  const yTicks = integerTicks(Math.max(...points.map((p) => p.created), 1));

  return (
    // `relative` anchors the sr-only span (see AcsOverTimeChart).
    <div data-testid="specs-over-time-chart" className="relative h-72">
      <ResponsiveBar<Datum>
        data={data}
        keys={['created']}
        indexBy="day"
        margin={{ top: 16, right: 16, bottom: 36, left: 40 }}
        padding={0.25}
        colors={[`${palette.accent}55`]}
        borderRadius={2}
        theme={insightsTheme}
        enableLabel={false}
        axisBottom={{
          tickSize: 0,
          tickPadding: 8,
          tickValues,
          format: shortDate,
        }}
        axisLeft={{ tickSize: 0, tickPadding: 8, tickValues: yTicks }}
        enableGridY
        gridYValues={yTicks}
        layers={[
          'grid',
          'axes',
          'bars',
          (props) => <CumulativeLineLayer {...props} accent={palette.accent} />,
        ]}
        tooltip={({ data: d }) => (
          <div className="text-xs">
            <div className="font-medium">{shortDate(d.day)}</div>
            <div>{d.created} created</div>
            <div style={{ color: palette.accent }}>{d.cumulative} total</div>
          </div>
        )}
        animate
      />
      <span className="sr-only">{`${total} specs total`}</span>
    </div>
  );
}
