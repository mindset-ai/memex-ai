// MetricBar — the big-percentage + progress-bar metric tile.
//
// Extracted from AcPanel (spec-188 t-3) so the Issues panel's resolution
// metric shares the exact visual identity of the AC coverage/verification
// metrics: `text-3xl font-bold tabular-nums` headline, `h-2 rounded-full`
// track, optional stacked segments with `transition-all`. One source — the
// two panels cannot drift apart visually.

// Colour of the headline number. Keys are limited to keep the palette
// consistent across surfaces — "green" for the headline-positive metric,
// "amber"/"amberWarm" for metrics that surface an action the user can take.
export type MetricColour = 'green' | 'amber' | 'amberWarm';
const METRIC_NUMBER_CLASS: Record<MetricColour, string> = {
  green: 'text-green-600 dark:text-green-400',
  amber: 'text-amber-500 dark:text-amber-400',
  amberWarm: 'text-amber-600 dark:text-amber-500',
};

// Bar segment colour key. Extends MetricColour with `rose` so a bar can
// surface failing items as a red segment instead of hiding them in the empty
// grey track, and `sky` (spec-188) for manually-accepted ACs — counted as
// verified but never disguised as test-verified green.
export type BarColour = 'green' | 'rose' | 'amber' | 'amberWarm' | 'sky';
const BAR_COLOUR_CLASS: Record<BarColour, string> = {
  green: 'bg-green-500',
  rose: 'bg-rose-500',
  amber: 'bg-amber-400',
  amberWarm: 'bg-amber-500',
  sky: 'bg-sky-500',
};

export interface BarSegment {
  /** Percent of the FULL bar width. Segments sum to ≤100 with the remainder
   *  left as the grey track. */
  percent: number;
  colour: BarColour;
  /** Optional test hook so we can assert which segment is which without
   *  reading tailwind class names. */
  testId?: string;
}

export function Metric({
  label,
  percent,
  colourClass,
  segments,
  caption,
  extra,
}: {
  label: string;
  percent: number;
  /** Colour of the headline number on the left. */
  colourClass: MetricColour;
  /** Optional: stacked segments rendered across the bar. When omitted, the
   *  bar shows a single `percent`-wide fill in `colourClass`. Used by the
   *  verified metric to expose failing (rose) and stale (amber) ACs as
   *  visible chunks rather than empty grey space. */
  segments?: BarSegment[];
  caption: string;
  extra?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <div
          className={`text-3xl font-bold tabular-nums ${METRIC_NUMBER_CLASS[colourClass]}`}
        >
          {percent}%
        </div>
        <div className={`text-sm ${METRIC_NUMBER_CLASS[colourClass]} opacity-80`}>
          {label}
        </div>
      </div>
      <div
        className="mt-2 h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden flex"
        data-testid={`metric-bar-${label}`}
      >
        {segments
          ? segments.map((seg, i) => (
              <div
                key={i}
                data-testid={seg.testId}
                data-segment-colour={seg.colour}
                className={`h-full ${BAR_COLOUR_CLASS[seg.colour]} transition-all`}
                style={{ width: `${seg.percent}%` }}
              />
            ))
          : (
              <div
                className={`h-full ${BAR_COLOUR_CLASS[colourClass]} transition-all`}
                style={{ width: `${percent}%` }}
              />
            )}
      </div>
      <div className="mt-1 text-xs text-muted flex items-center gap-3 flex-wrap">
        <span>{caption}</span>
        {extra && <span className="opacity-60">{extra}</span>}
      </div>
    </div>
  );
}
