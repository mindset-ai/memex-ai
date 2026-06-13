// spec-286: a compact relative-time helper for the QA Reports feed metadata line.
//
// The existing utils stop short of what the feed needs: `formatDate` (utils/format)
// is an absolute date and `relativeDays` (DoneSummary) only has day granularity.
// A QA report generated "2h ago" should read that way, not "today" or "12 Jun 2026".
//
// Granularity ladder (coarsening as it ages): just now → Nm → Nh → Nd → Nw, then it
// falls back to an absolute date so "63w ago" never appears. Always past-tense — a
// report's createdAt is in the past; a (clock-skew) future instant clamps to "just now".

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function absoluteDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Format `iso` as a short relative time from `now` (default: the current time).
 * `now` is injectable so tests are deterministic without faking the clock.
 *
 * Examples: "just now", "5m ago", "3h ago", "2d ago", "5w ago", then "12 Jun 2026".
 */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const diff = now.getTime() - then.getTime();
  if (diff < MINUTE) return 'just now'; // includes small future skew (diff < 0)

  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;
  // Up to ~8 weeks stays relative; beyond that an absolute date is more legible.
  if (diff < 8 * WEEK) return `${Math.floor(diff / WEEK)}w ago`;
  return absoluteDate(then);
}
