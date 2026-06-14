// spec-259 dec-5 — the ONE canonical relative-age helper, shared by server (MCP /
// agent surfaces) and the React UI. Before this, "time ago" was reimplemented ad
// hoc in ≥4 UI components and never existed server-side, while comments rendered
// three divergent absolute formats (formatDate YYYY-MM-DD, raw .toISOString(), and
// none). dec-5 rationalises every human/agent-facing WHEN to one relative rendering
// through this helper, while structured/wire forms keep absolute ISO-8601.
//
// `now` is INJECTABLE so MCP/agent output is deterministic under test (a fixed
// reference instant), while live calls default to the current time.
//
// Granularity ladder (coarsening as it ages): just now → Nm → Nh → Nd → Nw, then it
// falls back to an absolute date so "63w ago" never appears. Always past-tense — a
// row's timestamp is in the past; a (clock-skew) future instant clamps to "just now".
//
// Lifted from the spec-286 UI helper (packages/ui/src/utils/timeAgo.ts), which the
// UI now re-exports from here so there is one implementation.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function absoluteDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Format a timestamp as a short relative time from `now` (default: current time).
 * Accepts an ISO-8601 string or a `Date` (the server carries `Date` objects, the
 * UI carries ISO strings). `now` is injectable so tests are deterministic.
 *
 * Examples: "just now", "5m ago", "3h ago", "2d ago", "5w ago", then "12 Jun 2026".
 * Returns "" for an unparseable / null input (callers omit the byline rather than
 * render a broken one).
 */
export function timeAgo(value: string | Date | null | undefined, now: Date = new Date()): string {
  if (value == null) return '';
  const then = value instanceof Date ? value : new Date(value);
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
