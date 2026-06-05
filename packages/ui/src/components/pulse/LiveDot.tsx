// LiveDot — the single reusable pulse-animation primitive for Pulse (b-60).
//
// Used everywhere a "live activity" indicator is needed: the header "● Live"
// status line, per-row activity dots, and the tray-tile change indicators.
// Pure + presentational — it takes no data and owns no state.
//
//   live=true  → filled dot + a soft 2s ease-in-out breathe (animate-pulse-live,
//                defined in index.css). One colour token (status-success, the
//                app's "active/healthy" green) so every live dot matches.
//   live=false → hollow ring in the muted token (idle / no activity).
//
// Colour is driven by `currentColor` so callers can override the hue with a
// Tailwind text-* class when a context needs a different signal (e.g. a 'dead'
// connection rendered red) — the default tracks the success token.

export type LiveDotSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<LiveDotSize, string> = {
  sm: 'w-1.5 h-1.5',
  md: 'w-2 h-2',
  lg: 'w-2.5 h-2.5',
};

export interface LiveDotProps {
  /** Filled + pulsing when true; hollow ring when false. Default false. */
  live?: boolean;
  /** Dot diameter. Default 'md'. */
  size?: LiveDotSize;
  /** Extra classes — typically a `text-*` token to recolour the dot. */
  className?: string;
  /** Accessible label / tooltip. */
  title?: string;
}

export function LiveDot({
  live = false,
  size = 'md',
  className = '',
  title,
}: LiveDotProps) {
  const sizeClass = SIZE_CLASS[size];

  // Live: filled disc in the current text colour, breathing. Idle: hollow ring.
  const stateClass = live
    ? 'bg-current animate-pulse-live'
    : 'bg-transparent border border-current opacity-60';

  // Default hue is the success token; callers override via `className`.
  const colorClass = /\btext-/.test(className) ? '' : 'text-status-success-text';

  return (
    <span
      role={title ? 'img' : undefined}
      aria-label={title}
      title={title}
      className={`inline-block shrink-0 rounded-full ${sizeClass} ${stateClass} ${colorClass} ${className}`}
    />
  );
}
