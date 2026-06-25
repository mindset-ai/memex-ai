// spec-406 (dec-3): the who/what/when audit for one spec. A chronological table
// off activity_view, curated by default (reads, test-events and system sweeps
// excluded server-side) with a "Show everything" toggle that re-admits the full
// slice. Each row carries WHO · WHEN · HOW · WHAT per the std-32 activity contract.

import { useEffect, useState } from 'react';
import { fetchSpecActivity, type SpecActivityRow } from '../../api/insights';
import { useChartPalette } from './theme';

interface Props {
  specRef: string;
}

const PAGE = 50;

// Actor-hue families (std-27 cl-4): humans = blue, MCP agent = violet, memex
// agent = cyan. Channel is the cheapest signal of which.
function channelTone(channel: string | null, palette: ReturnType<typeof useChartPalette>): string {
  if (channel === 'mcp') return palette.actor.mcp_agent;
  if (channel === 'in_app_agent') return palette.actor.in_app_agent;
  return palette.actor.human;
}

// Friendly labels for the std-32 `channel` enum (the surface a write came from) —
// never show the raw enum to a reader.
const CHANNEL_LABEL: Record<string, string> = {
  rest_ui: 'Web',
  mcp: 'MCP',
  in_app_agent: 'In-app agent',
  server: 'Server',
};
function channelLabel(channel: string | null): string {
  return channel ? CHANNEL_LABEL[channel] ?? channel : '—';
}

// std-32 attribution is forward-only, so many (older / source-table) rows carry
// no stamped `actor_name`. When that happens, name the actor by the agent the
// channel implies rather than leaving the WHO blank.
const CHANNEL_ACTOR: Record<string, string> = {
  in_app_agent: 'Memex agent',
  mcp: 'Coding agent',
  server: 'System',
};
function whoLabel(row: { actorName: string | null; channel: string | null }): string {
  if (row.actorName) return row.actorName;
  if (row.channel && CHANNEL_ACTOR[row.channel]) return CHANNEL_ACTOR[row.channel];
  return '—';
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function SpecActivityAudit({ specRef }: Props) {
  const palette = useChartPalette();
  const [showAll, setShowAll] = useState(false);
  const [rows, setRows] = useState<SpecActivityRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSpecActivity(specRef, { showAll, limit: PAGE })
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        setHasMore(res.hasMore);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [specRef, showAll]);

  return (
    <div data-testid="spec-activity-audit">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-secondary">
          {showAll ? 'every event, including reads and system writes' : 'meaningful work — reads, test-events and system noise excluded'}
        </div>
        <label className="text-xs inline-flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            data-testid="audit-show-all"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          Show everything
        </label>
      </div>

      {loading && rows.length === 0 ? (
        <div className="text-sm text-secondary py-6 text-center">Loading activity…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-secondary py-6 text-center">No activity recorded yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-xs text-secondary text-left border-b border-[rgb(var(--ch-edge,148_163_184)/0.3)]">
                <th className="py-1.5 pr-3 font-medium">When</th>
                <th className="py-1.5 pr-3 font-medium">Who</th>
                <th className="py-1.5 pr-3 font-medium">How</th>
                <th className="py-1.5 font-medium">What</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.entityId ?? i} className="border-b border-[rgb(var(--ch-edge,148_163_184)/0.12)] align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-secondary text-xs">{fmtWhen(r.at)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span style={{ color: channelTone(r.channel, palette) }}>{whoLabel(r)}</span>
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-xs text-secondary">{channelLabel(r.channel)}</td>
                  <td className="py-1.5 text-primary">
                    <span className="text-xs uppercase tracking-wide text-secondary mr-1.5">{r.kind}</span>
                    {r.action}
                    {r.narrative && <span className="text-secondary"> — {r.narrative.slice(0, 120)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <div className="text-xs text-secondary py-2 text-center">
              Showing the {PAGE} most recent events.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
