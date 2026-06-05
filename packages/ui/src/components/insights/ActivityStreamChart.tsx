// spec-179 (ac-18): the human-vs-agent activity stream — "who is doing the
// work?" Per-day Pulse activity split by actor kind, rendered as a stream so
// the changing human/agent mix reads at a glance. Reads (`viewed`),
// test-event rows and `system` actors (sweeps/plumbing) are excluded
// server-side; this is authored work, not noise.

import { ResponsiveStream } from '@nivo/stream';
import type { ActivityByActorPoint } from '../../api/client';
import { TOOLTIP_STYLE, insightsTheme, shortDate, useChartPalette } from './theme';

interface Props {
  points: ActivityByActorPoint[];
}

// The stream is keyed by DISPLAY labels — Nivo surfaces layer ids verbatim in
// the legend (it ignores custom legend `data`), so keying by the API's enum
// names would leak `in_app_agent` into the UI.
const ACTOR_LABELS = {
  human: 'humans',
  mcp_agent: 'coding agents (MCP)',
  in_app_agent: 'memex agent',
} as const;
const ACTOR_KEYS = Object.values(ACTOR_LABELS);

export function ActivityStreamChart({ points }: Props) {
  const { actor: actorColors } = useChartPalette();
  const colorByLabel: Record<string, string> = {
    [ACTOR_LABELS.human]: actorColors.human,
    [ACTOR_LABELS.mcp_agent]: actorColors.mcp_agent,
    [ACTOR_LABELS.in_app_agent]: actorColors.in_app_agent,
  };
  // Stream is index-based; keep the day strings alongside for axis + tooltip.
  const days = points.map((p) => p.day);
  const data = points.map((p) => ({
    [ACTOR_LABELS.human]: p.human,
    [ACTOR_LABELS.mcp_agent]: p.mcp_agent,
    [ACTOR_LABELS.in_app_agent]: p.in_app_agent,
  }));
  const every = Math.max(1, Math.ceil(days.length / 8));

  return (
    <div data-testid="activity-stream-chart" className="h-72">
      <ResponsiveStream
        data={data}
        keys={ACTOR_KEYS}
        margin={{ top: 16, right: 16, bottom: 36, left: 40 }}
        colors={(layer) => colorByLabel[String(layer.id)]}
        theme={insightsTheme}
        offsetType="none"
        curve="monotoneX"
        // Same glass treatment as the stacked area — translucent fill, the
        // full-strength color reserved for the band edge.
        fillOpacity={0.4}
        borderWidth={1.5}
        borderColor={{ from: 'color' }}
        axisBottom={{
          tickSize: 0,
          tickPadding: 8,
          format: (i) => (Number(i) % every === 0 ? shortDate(days[Number(i)] ?? '') : ''),
        }}
        axisLeft={{ tickSize: 0, tickPadding: 8 }}
        enableGridX={false}
        legends={[
          {
            anchor: 'top-right',
            direction: 'row',
            translateY: -16,
            itemWidth: 130,
            itemHeight: 16,
            symbolSize: 10,
            symbolShape: 'circle',
          },
        ]}
        tooltip={({ layer }) => (
          <div
            className="text-xs rounded-lg px-3 py-2"
            style={TOOLTIP_STYLE}
          >
            <span
              className="inline-block w-2 h-2 rounded-full mr-1.5"
              style={{ background: layer.color }}
            />
            {String(layer.id)}
          </div>
        )}
        // Hovering the chart body shows Nivo's default stack tooltip unless
        // overridden — an off-theme box of raw enum keys. Replace it with the
        // themed day breakdown.
        stackTooltip={({ slice }) => (
          <div className="text-xs rounded-lg px-3 py-2" style={TOOLTIP_STYLE}>
            <div className="font-medium mb-1">{shortDate(days[slice.index] ?? '')}</div>
            {slice.stack.map((layer) => (
              <div key={String(layer.layerId)} className="flex items-center gap-1.5">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ background: layer.color }}
                />
                <span>{String(layer.layerId)}</span>
                <span className="ml-auto pl-3 font-medium">{layer.value}</span>
              </div>
            ))}
          </div>
        )}
        animate
      />
    </div>
  );
}
