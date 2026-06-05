// spec-179 (ac-19): ACs created vs verified over time — "is verification
// keeping up with intent?" Two cumulative lines: commitments (ACs created)
// and proof (ACs first-verified by a passing emission). The vertical gap
// between them IS the verification debt; a closing gap is a healthy memex.

import { ResponsiveLine } from '@nivo/line';
import type { AcsOverTimePoint } from '../../api/client';
import { TOOLTIP_STYLE, insightsTheme, integerTicks, shortDate, useChartPalette } from './theme';

interface Props {
  points: AcsOverTimePoint[];
}

export function AcsOverTimeChart({ points }: Props) {
  const palette = useChartPalette();
  const createdColor = palette.accent; // intent
  const verifiedColor = palette.verification.verified; // proof
  const data = [
    {
      id: 'created',
      color: createdColor,
      data: points.map((p) => ({ x: p.day, y: p.created })),
    },
    {
      id: 'verified',
      color: verifiedColor,
      data: points.map((p) => ({ x: p.day, y: p.verified })),
    },
  ];
  const every = Math.max(1, Math.ceil(points.length / 8));
  const tickValues = points.filter((_, i) => i % every === 0).map((p) => p.day);
  const yTicks = integerTicks(Math.max(...points.map((p) => p.created), 1));
  const last = points[points.length - 1];
  const debt = last ? last.created - last.verified : 0;

  return (
    // `relative` anchors the absolutely-positioned sr-only span — without a
    // positioned ancestor it resolves against the document and silently
    // stretches the page scroll height past the app shell.
    <div data-testid="acs-over-time-chart" className="relative h-72">
      <ResponsiveLine
        data={data}
        xScale={{ type: 'point' }}
        yScale={{ type: 'linear', min: 0, max: 'auto' }}
        margin={{ top: 24, right: 16, bottom: 36, left: 40 }}
        colors={(serie) => String(serie.color)}
        theme={insightsTheme}
        curve="monotoneX"
        enablePoints={false}
        enableArea
        areaOpacity={0.12}
        lineWidth={2.5}
        axisBottom={{ tickSize: 0, tickPadding: 8, tickValues, format: (v) => shortDate(String(v)) }}
        axisLeft={{ tickSize: 0, tickPadding: 8, tickValues: yTicks }}
        gridYValues={yTicks}
        enableGridX={false}
        enableSlices="x"
        legends={[
          {
            anchor: 'top-left',
            direction: 'row',
            translateY: -24,
            itemWidth: 90,
            itemHeight: 16,
            symbolSize: 10,
            symbolShape: 'circle',
          },
        ]}
        sliceTooltip={({ slice }) => {
          const byId = Object.fromEntries(slice.points.map((pt) => [pt.seriesId, pt.data.y]));
          const gap = Number(byId.created ?? 0) - Number(byId.verified ?? 0);
          return (
            <div
              className="text-xs rounded-lg px-3 py-2"
              style={TOOLTIP_STYLE}
            >
              <div className="font-medium mb-1">{shortDate(String(slice.points[0]?.data.x))}</div>
              <div style={{ color: createdColor }}>{String(byId.created ?? 0)} created</div>
              <div style={{ color: verifiedColor }}>{String(byId.verified ?? 0)} verified</div>
              <div className="text-secondary">{gap} unproven</div>
            </div>
          );
        }}
        animate
      />
      <span className="sr-only">{`${debt} ACs currently unproven`}</span>
    </div>
  );
}
