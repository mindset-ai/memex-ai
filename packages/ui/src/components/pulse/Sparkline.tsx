// Sparkline — spec-255: a small SVG LINE sparkline with a slowly-pulsing end
// dot, matching the Pulse mockup. Shared by the Vitals tempo strip and each Hot
// Spec card. Deliberately a line (not bars) — the bar treatment belongs to the
// test-signal monitor, not the activity tempo.

interface SparklineProps {
  /** Series values, oldest → newest. Empty renders a flat baseline. */
  values: number[];
  width?: number;
  height?: number;
  /** Stroke + dot colour. Defaults to currentColor so callers theme it. */
  color?: string;
  /** Pulse the end dot (a live series). Off renders a static dot. */
  live?: boolean;
  className?: string;
  title?: string;
}

const PAD = 3;

export function Sparkline({
  values,
  width = 72,
  height = 22,
  color = 'currentColor',
  live = true,
  className,
  title,
}: SparklineProps) {
  const n = values.length;
  const min = n ? Math.min(...values) : 0;
  const max = n ? Math.max(...values) : 1;
  const range = max - min || 1;
  const step = n > 1 ? (width - PAD * 2) / (n - 1) : 0;

  const pts = values.map((v, i) => {
    const x = PAD + i * step;
    const y = height - PAD - ((v - min) / range) * (height - PAD * 2);
    return [x, y] as const;
  });
  // A single point (or none) still needs a baseline so the dot has a home.
  if (pts.length === 0) pts.push([PAD, height - PAD] as const);
  if (pts.length === 1) pts.unshift([0, pts[0][1]] as const);

  const d = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={title ?? 'sparkline'}
      data-testid="sparkline"
    >
      <polyline
        points={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.9}
      />
      {/* Breathing end-dot: an expanding/fading ring + a gently pulsing core.
          SMIL keeps it self-contained (no global keyframes) and reliable. */}
      <circle cx={lx} cy={ly} r={2} fill="none" stroke={color} strokeWidth={1} opacity={live ? 0.5 : 0}>
        {live && <animate attributeName="r" values="2;5.5;2" dur="2.6s" repeatCount="indefinite" />}
        {live && <animate attributeName="opacity" values="0.5;0;0.5" dur="2.6s" repeatCount="indefinite" />}
      </circle>
      <circle cx={lx} cy={ly} r={1.9} fill={color}>
        {live && <animate attributeName="opacity" values="1;0.35;1" dur="2.6s" repeatCount="indefinite" />}
      </circle>
    </svg>
  );
}
