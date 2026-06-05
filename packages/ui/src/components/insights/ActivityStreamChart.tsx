// spec-179 (ac-18): the human-vs-agent activity stream — "who is doing the
// work?" Per-day Pulse activity split by actor kind, rendered as a stream so
// the changing human/agent mix reads at a glance. Reads (`viewed`) and
// test-event rows are excluded server-side; this is authored work, not noise.

import { ResponsiveStream } from '@nivo/stream';
import type { ActivityByActorPoint } from '../../api/client';
import { insightsTheme, shortDate } from './theme';

interface Props {
  points: ActivityByActorPoint[];
}

const ACTORS = ['human', 'mcp_agent', 'in_app_agent', 'system'] as const;

const ACTOR_LABELS: Record<(typeof ACTORS)[number], string> = {
  human: 'humans',
  mcp_agent: 'coding agents (MCP)',
  in_app_agent: 'in-app agent',
  system: 'system',
};

const ACTOR_COLORS: Record<(typeof ACTORS)[number], string> = {
  human: '#6366f1', // indigo — people
  mcp_agent: '#f97316', // orange — coding agents over MCP
  in_app_agent: '#06b6d4', // cyan — the in-app agent
  system: '#94a3b8', // slate — plumbing
};

export function ActivityStreamChart({ points }: Props) {
  // Stream is index-based; keep the day strings alongside for axis + tooltip.
  const days = points.map((p) => p.day);
  const data = points.map((p) => ({
    human: p.human,
    mcp_agent: p.mcp_agent,
    in_app_agent: p.in_app_agent,
    system: p.system,
  }));
  const every = Math.max(1, Math.ceil(days.length / 8));

  return (
    <div data-testid="activity-stream-chart" className="h-72">
      <ResponsiveStream
        data={data}
        keys={[...ACTORS]}
        margin={{ top: 16, right: 16, bottom: 36, left: 40 }}
        colors={(layer) => ACTOR_COLORS[layer.id as (typeof ACTORS)[number]]}
        theme={insightsTheme}
        offsetType="none"
        curve="monotoneX"
        fillOpacity={0.85}
        borderWidth={1}
        borderColor={{ from: 'color', modifiers: [['darker', 0.4]] }}
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
            data: ACTORS.map((a) => ({
              id: a,
              label: ACTOR_LABELS[a],
              color: ACTOR_COLORS[a],
            })),
          },
        ]}
        tooltip={({ layer }) => (
          <div
            className="text-xs rounded-lg px-3 py-2"
            style={{ background: 'var(--color-surface, #fff)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}
          >
            <span
              className="inline-block w-2 h-2 rounded-full mr-1.5"
              style={{ background: layer.color }}
            />
            {ACTOR_LABELS[layer.id as (typeof ACTORS)[number]]}
          </div>
        )}
        animate
      />
    </div>
  );
}
