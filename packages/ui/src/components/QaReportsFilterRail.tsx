// spec-286: the QA Reports feed's left-hand filter rail. It STAYS IN PLACE while
// the report list scrolls (sticky) and offers two stacked filter groups:
//
//   1. A tag tree rooted at "All" (every report) with one node per tag carrying
//      its whole-corpus report count. Selecting a node filters the feed.
//   2. Date filters — quick "Last week" / "Last month" ranges, an "All time"
//      reset, and a custom from/to range.
//
// A tag selection and a date range compose with AND in the page (dec-3); the rail
// just reports the user's intent up via callbacks. Counts come from the server
// facet endpoint (dec-2), so they are correct across the whole corpus regardless
// of how far the feed has paged.

import { TagChip } from './TagChip';
import type { QaReportFacets } from '../hooks/useQaReports';

export type DateRangePreset = 'all' | 'week' | 'month' | 'custom';

export interface DateRangeState {
  preset: DateRangePreset;
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

export const ALL_TIME: DateRangeState = { preset: 'all' };

/** ISO instant `days` before `now` — the lower bound for a quick range. */
function daysAgoIso(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

interface QaReportsFilterRailProps {
  facets: QaReportFacets;
  loading: boolean;
  /** Currently selected tag id, or null for "All". */
  selectedTagId: string | null;
  onSelectTag: (tagId: string | null) => void;
  range: DateRangeState;
  onChangeRange: (range: DateRangeState) => void;
}

export function QaReportsFilterRail({
  facets,
  loading,
  selectedTagId,
  onSelectTag,
  range,
  onChangeRange,
}: QaReportsFilterRailProps) {
  // `<input type="date">` wants a bare YYYY-MM-DD; our state carries full ISO.
  const fromDate = range.from ? range.from.slice(0, 10) : '';
  const toDate = range.to ? range.to.slice(0, 10) : '';

  const setCustom = (next: { from?: string; to?: string }) => {
    const from = next.from !== undefined ? next.from : fromDate;
    const to = next.to !== undefined ? next.to : toDate;
    onChangeRange({
      preset: 'custom',
      // End-of-day on `to` so the chosen day is inclusive.
      from: from ? `${from}T00:00:00.000Z` : undefined,
      to: to ? `${to}T23:59:59.999Z` : undefined,
    });
  };

  return (
    <aside
      data-testid="qa-reports-rail"
      // sticky + self-start keeps the rail in place while the feed column scrolls.
      className="sticky top-4 self-start w-56 shrink-0 max-h-[calc(100vh-2rem)] overflow-y-auto pr-2"
    >
      <div data-testid="qa-reports-tag-tree">
        <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted">Tags</h2>
        <ul className="mt-1 space-y-0.5">
          <li>
            <button
              type="button"
              data-testid="qa-reports-tag-all"
              aria-pressed={selectedTagId === null}
              onClick={() => onSelectTag(null)}
              className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-sm ${
                selectedTagId === null
                  ? 'bg-overlay text-primary font-medium'
                  : 'text-secondary hover:bg-overlay hover:text-primary'
              }`}
            >
              <span>All</span>
              <span className="text-xs text-muted tabular-nums">{facets.total}</span>
            </button>
          </li>
          {facets.tags.map((tag) => (
            <li key={tag.id}>
              <button
                type="button"
                data-testid="qa-reports-tag-node"
                data-tag-id={tag.id}
                aria-pressed={selectedTagId === tag.id}
                onClick={() => onSelectTag(tag.id)}
                className={`flex w-full items-center justify-between gap-1 rounded-md px-2 py-1 ${
                  selectedTagId === tag.id ? 'bg-overlay' : 'hover:bg-overlay'
                }`}
              >
                <TagChip tag={tag} />
                <span
                  data-testid="qa-reports-tag-count"
                  className="text-xs text-muted tabular-nums"
                >
                  {tag.count}
                </span>
              </button>
            </li>
          ))}
          {!loading && facets.tags.length === 0 && (
            <li className="px-2 py-1 text-xs text-muted">No tags yet</li>
          )}
        </ul>
      </div>

      <div data-testid="qa-reports-date-filters" className="mt-5">
        <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted">When</h2>
        <div className="mt-1 flex flex-wrap gap-1 px-2">
          {(
            [
              { key: 'all', label: 'All time', build: (): DateRangeState => ALL_TIME },
              { key: 'week', label: 'Last week', build: (): DateRangeState => ({ preset: 'week', from: daysAgoIso(7) }) },
              { key: 'month', label: 'Last month', build: (): DateRangeState => ({ preset: 'month', from: daysAgoIso(30) }) },
            ] as const
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              data-testid={`qa-reports-range-${opt.key}`}
              aria-pressed={range.preset === opt.key}
              onClick={() => onChangeRange(opt.build())}
              className={`rounded-full border px-2 py-0.5 text-xs ${
                range.preset === opt.key
                  ? 'border-accent text-accent'
                  : 'border-edge-subtle text-secondary hover:text-primary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-col gap-1 px-2 text-xs text-secondary">
          <label className="flex items-center justify-between gap-2">
            <span>From</span>
            <input
              type="date"
              data-testid="qa-reports-range-from"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => setCustom({ from: e.target.value })}
              className="qa-date-input w-36 rounded border border-edge-subtle bg-surface px-1 py-0.5 text-primary"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>To</span>
            <input
              type="date"
              data-testid="qa-reports-range-to"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => setCustom({ to: e.target.value })}
              className="qa-date-input w-36 rounded border border-edge-subtle bg-surface px-1 py-0.5 text-primary"
            />
          </label>
        </div>
      </div>
    </aside>
  );
}
