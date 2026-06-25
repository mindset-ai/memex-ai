// spec-406 (dec-4): the per-spec phase timeline — a Gantt-style strip on a real
// date axis. Each visit to a phase is drawn where it actually happened, so
// re-entries (verify→build→verify) appear as separate segments and idle gaps
// between phases are visible literally. Nivo has no Gantt primitive and its bar
// charts can't position bars at arbitrary time offsets, so this is a custom SVG —
// but it still draws from the ONE shared palette (useChartPalette, std-27) so the
// reserved phase hues match every other chart.

import { useState } from 'react';
import type { SpecPhaseDurations } from '../../api/insights';
import { phaseLabel, shortDate, useChartPalette } from './theme';

interface Props {
  data: SpecPhaseDurations;
}

const fmtDays = (d: number) => (d >= 1 ? `${d.toFixed(d >= 10 ? 0 : 1)}d` : `${Math.round(d * 24)}h`);

export function SpecPhaseTimelineChart({ data }: Props) {
  const { phase: phaseColors } = useChartPalette();
  const [hover, setHover] = useState<number | null>(null);

  if (data.segments.length === 0) {
    return (
      <div
        data-testid="spec-phase-timeline"
        className="h-24 flex items-center justify-center text-sm text-secondary"
      >
        This spec hasn&apos;t entered a phase yet — the timeline unlocks on its first transition.
      </div>
    );
  }

  const now = Date.now();
  const starts = data.segments.map((s) => new Date(s.start).getTime());
  const ends = data.segments.map((s) => (s.end ? new Date(s.end).getTime() : now));
  const t0 = Math.min(...starts);
  const t1 = Math.max(...ends, now);
  const span = Math.max(1, t1 - t0);
  const pct = (ms: number) => `${((ms - t0) / span) * 100}%`;
  const width = (a: number, b: number) => `${((b - a) / span) * 100}%`;

  // The phases present, in first-appearance order, for the legend.
  const legendPhases = [...new Set(data.segments.map((s) => s.phase))];

  return (
    <div data-testid="spec-phase-timeline" className="relative">
      {/* The timeline band. */}
      <div className="relative h-9 w-full rounded-md bg-[rgb(var(--ch-edge,148_163_184)/0.12)] overflow-hidden">
        {data.segments.map((seg, i) => {
          const a = new Date(seg.start).getTime();
          const b = seg.end ? new Date(seg.end).getTime() : now;
          const days = (b - a) / 86_400_000;
          return (
            <div
              key={i}
              data-testid="phase-segment"
              data-phase={seg.phase}
              className="absolute top-0 h-full transition-[opacity] duration-300"
              style={{
                left: pct(a),
                width: width(a, b),
                background: `${phaseColors[seg.phase]}${hover === null || hover === i ? 'cc' : '66'}`,
                borderRight: seg.end ? '1px solid rgb(var(--ch-surface,255 255 255))' : undefined,
              }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {hover === i && (
                <div
                  className="absolute z-10 bottom-full mb-1 left-0 whitespace-nowrap text-xs rounded-lg px-3 py-2"
                  style={{ background: 'rgb(var(--ch-surface, 255 255 255))', color: 'rgb(var(--ch-text-primary, 15 23 42))', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}
                >
                  <span className="font-medium">{phaseLabel(seg.phase)}</span> · {fmtDays(days)}
                  {!seg.end && ' (ongoing)'}
                  <div className="text-secondary">
                    {shortDate(seg.start.slice(0, 10))} → {seg.end ? shortDate(seg.end.slice(0, 10)) : 'now'}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Date axis endpoints. */}
      <div className="flex justify-between text-[10px] text-secondary mt-1">
        <span>{shortDate(new Date(t0).toISOString().slice(0, 10))}</span>
        <span>now</span>
      </div>

      {/* Legend with reserved hues + per-phase totals. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
        {legendPhases.map((p) => {
          const total = data.totals.find((t) => t.phase === p);
          return (
            <span key={p} className="inline-flex items-center gap-1.5 text-primary">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: phaseColors[p] }} />
              {phaseLabel(p)}
              {total && <span className="text-secondary">· {fmtDays(total.days)}</span>}
            </span>
          );
        })}
      </div>

      {data.caveat && (
        <div data-testid="phase-timeline-caveat" className="text-xs text-secondary mt-2 italic">
          {data.caveat}
        </div>
      )}
    </div>
  );
}
