// Hand-rolled SVG sparkline for the AC tab — shows alignment %
// (verified / total) across the last N days. No charting dependency on
// purpose: pulling in recharts/visx for one ~250-line file is the wrong
// trade.
//
// Sizing: the parent supplies the WIDTH via container width (measured with
// ResizeObserver) so the SVG always fills the available space and the date
// labels below it line up correctly with the rightmost data point. Earlier
// V0.0.1 hardcoded width=520 and the "today" label sat further right than
// the actual last point — that's the bug this version fixes.
//
// Behaviour:
//   - Empty data        → renders the baseline + a "no history yet" hint.
//   - One data point    → renders as a tiny dot, no path.
//   - All-100% data     → flat green line at the top. Looks like a flat
//                         green line, which is exactly the message.
//   - Hover             → vertical guide line + a small tooltip showing
//                         date + verified/total + percentage for the point
//                         under the cursor. Snaps to the nearest x.
//
// Y-axis is fixed 0..100 (absolute %, not stretched to data range).
// X-axis is index-based (day count). Coordinates: SVG y grows downward, so
// verified=100 maps to the TOP.

import { useEffect, useRef, useState } from 'react';
import type { AcAlignmentDay } from '../api/client';

export interface AcSparklineProps {
  /** Per-day rows for ONE kind (caller filters before passing in). */
  data: AcAlignmentDay[];
  /** Height in px. Width is derived from container. */
  height?: number;
  /** Stroke colour for the line + dot. Defaults to Tailwind green-500. */
  stroke?: string;
  /** Optional className for outer wrapper. */
  className?: string;
}

function percent(d: AcAlignmentDay): number {
  if (d.total === 0) return 0;
  return (d.verified / d.total) * 100;
}

export function AcSparkline({
  data,
  height = 48,
  stroke = '#22c55e',
  className,
}: AcSparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(320);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Track container width so the SVG fills the available space. Re-measure
  // on resize so the sparkline reflows correctly with the sidebar / window.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setWidth(Math.floor(w));
      }
    });
    observer.observe(el);
    // Seed an initial measurement so the first paint has a real width.
    const initial = el.getBoundingClientRect().width;
    if (initial > 0) setWidth(Math.floor(initial));
    return () => observer.disconnect();
  }, []);

  const padX = 4;
  const padY = 4;
  const usableW = Math.max(0, width - 2 * padX);
  const usableH = height - 2 * padY;

  const points = data.map((d, i) => {
    const x =
      data.length <= 1
        ? padX + usableW / 2
        : padX + (i / (data.length - 1)) * usableW;
    const pct = percent(d);
    const y = padY + (1 - pct / 100) * usableH;
    return { x, y, pct, date: d.date, verified: d.verified, total: d.total };
  });

  const path =
    points.length >= 2
      ? `M ${points[0].x} ${points[0].y} ` +
        points.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ')
      : '';

  const lastPoint = points[points.length - 1];
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    if (points.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Find the index whose x is closest to the cursor.
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].x - x);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    setHoverIndex(bestIdx);
  }

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      {data.length === 0 ? (
        <div className="text-xs text-muted italic py-2">
          No alignment history yet.
        </div>
      ) : (
        <>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Alignment over ${data.length} days, currently ${
              lastPoint ? Math.round(lastPoint.pct) : 0
            }% verified`}
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
            style={{ display: 'block' }}
          >
            {/* Baseline + top dashed line so the band reads as a chart. */}
            <line
              x1={padX}
              x2={width - padX}
              y1={height - padY}
              y2={height - padY}
              stroke="currentColor"
              strokeOpacity={0.1}
              strokeWidth={1}
            />
            <line
              x1={padX}
              x2={width - padX}
              y1={padY}
              y2={padY}
              stroke="currentColor"
              strokeOpacity={0.05}
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            {path && (
              <path
                d={path}
                fill="none"
                stroke={stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {/* Hover guide line + dot. */}
            {hovered && (
              <>
                <line
                  x1={hovered.x}
                  x2={hovered.x}
                  y1={padY}
                  y2={height - padY}
                  stroke="currentColor"
                  strokeOpacity={0.3}
                  strokeWidth={1}
                />
                <circle cx={hovered.x} cy={hovered.y} r={4} fill={stroke} />
              </>
            )}
            {/* The persistent "where are we now" dot at the last point. */}
            {lastPoint && !hovered && (
              <circle cx={lastPoint.x} cy={lastPoint.y} r={3} fill={stroke} />
            )}
          </svg>
          {/* Tooltip — positioned in CSS so it can extend outside the SVG. */}
          {hovered && (
            <div
              className="absolute pointer-events-none rounded-md bg-zinc-900 text-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 text-xs px-2 py-1 shadow-md whitespace-nowrap"
              style={{
                left: Math.min(Math.max(hovered.x - 50, 0), width - 100),
                top: Math.max(hovered.y - 44, 0),
              }}
            >
              <div className="font-medium">{hovered.date}</div>
              <div>
                {hovered.verified}/{hovered.total} verified ·{' '}
                {hovered.total === 0 ? '—' : `${Math.round(hovered.pct)}%`}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
