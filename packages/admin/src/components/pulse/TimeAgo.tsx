// TimeAgo — a self-ticking relative-time label for Pulse (b-60).
//
// Pure + presentational apart from one internal interval that re-renders the
// label every ~15s so "Just now" ages into "1m ago" without the parent having
// to re-render. Takes an ISO-8601 string or a Date.
//
// Format ladder:
//   < 10s            → "Just now"
//   < 60s            → "Ns ago"
//   < 60m            → "Nm ago"
//   < 24h            → "Nh ago"
//   yesterday        → "Yesterday"
//   < 7 days         → "Nd ago"
//   >= 7 days        → absolute date (reuses utils/format.ts formatDate)
//
// The `<time>` element carries the exact ISO timestamp in `dateTime` and the
// full locale string in `title`, so the relative label stays scannable while
// the precise value is one hover away.

import { useEffect, useState } from 'react';
import { formatDate } from '../../utils/format';

const TICK_MS = 15_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface TimeAgoProps {
  /** The instant to describe — ISO-8601 string or Date. */
  value: string | Date;
  /** Extra classes for the <time> element. */
  className?: string;
}

/**
 * Pure relative-time formatter. Exported so it can be unit-tested and reused by
 * non-React callers without spinning up the ticking component.
 */
export function formatTimeAgo(value: string | Date, now: number = Date.now()): string {
  const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(then)) return '';

  const diffMs = now - then;

  // Future timestamps (clock skew) read as "Just now" rather than negatives.
  if (diffMs < 10_000) return 'Just now';

  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  // Calendar-day comparison so "yesterday" tracks the local day boundary, not a
  // flat 24–48h window.
  const thenDay = startOfDay(then);
  const nowDay = startOfDay(now);
  const dayDiff = Math.round((nowDay - thenDay) / (24 * 60 * 60 * 1000));
  if (dayDiff === 1) return 'Yesterday';

  if (diffMs < SEVEN_DAYS_MS) {
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // Older than a week → absolute date, matching the app's date formatting.
  return formatDate(value instanceof Date ? value.toISOString() : value);
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function TimeAgo({ value, className }: TimeAgoProps) {
  // Re-render on a fixed cadence so the label ages in place. We store a tick
  // counter rather than the formatted string so the format ladder is always
  // evaluated against a fresh `Date.now()`.
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const iso = value instanceof Date ? value.toISOString() : value;
  const label = formatTimeAgo(value);
  const date = value instanceof Date ? value : new Date(value);
  const title = Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();

  return (
    <time dateTime={iso} title={title} className={className}>
      {label}
    </time>
  );
}
