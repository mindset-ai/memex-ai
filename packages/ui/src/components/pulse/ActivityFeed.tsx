// ActivityFeed — the left column of Pulse (b-60, dec-10).
//
// PRESENTATIONAL. Rows + connection status + paging signals arrive via props;
// the Pulse page owns the stream/history hooks. This component is responsible
// for the *presentation* concerns that are purely a function of the rows it's
// handed:
//
//   - the top "● Live · N events in last hour" status line (dot hue tracks the
//     connection status — green pulse / amber / red),
//   - newest-first ordering with faint day-break separators,
//   - dec-10 burst collapse: consecutive same-(clientId, briefId) rows within a
//     short window fold into one expandable ActivityRow group (expand state is
//     local to the feed),
//   - per-row "live" styling for rows < 30s old + a one-shot highlight tint on
//     freshly-arrived (`live-`-id) rows,
//   - backward infinite scroll via a [Load older] button (→ onLoadOlder), with
//     skeleton rows while loading.
//
// Everything time-relative is computed against a single `now` captured per
// render and refreshed on a slow tick, so "live" and the day separators don't
// drift without a parent re-render.

import { useEffect, useMemo, useState } from 'react';
import { LiveDot } from './LiveDot';
import { ActivityRow } from './ActivityRow';
import type { ActivityRow as ActivityRowData, PulseConnectionStatus } from './types';

export interface ActivityFeedProps {
  /** Activity rows. Any order on the way in — the feed sorts newest-first. */
  rows: ActivityRowData[];
  /** Live-connection health; drives the status line dot + label. */
  status: PulseConnectionStatus;
  /** Count for the status line ("N events in last hour"). Defaults to 0. */
  eventsLastHour?: number;
  /** Initial load in flight → render skeleton rows. */
  loading?: boolean;
  /** More history available behind the oldest row → show [Load older]. */
  hasMore?: boolean;
  /** Fetch the next older page. */
  onLoadOlder?: () => void;
  /**
   * When the feed is embedded in a Spec-scoped view, pass that Spec's handle
   * so each row can drop a redundant "… in <handle>" suffix.
   */
  contextBriefHandle?: string;
  /** Resolve a resource handle → its title (rows show "b-2 Pulse …"). */
  specTitle?: (handle: string) => string | undefined;
  /**
   * spec-122 ac-2 — true when a row is a REGRESSION (a previously-verified AC
   * going red), so the feed renders the `⚠ REGRESSED` flag on it.
   */
  isRegression?: (row: ActivityRowData) => boolean;
  /**
   * spec-122 ac-2 — true when the row's spec has an active worker present in
   * "Working now". A regression on a worked spec is muted (expected churn); a
   * regression on a quiet spec earns the full-weight alarm.
   */
  specHasActiveWorker?: (briefId: string | null) => boolean;
}

// dec-10 burst window: consecutive rows from the same client on the same Spec
// within this gap fold into one group. A const so it's easy to tune.
const BURST_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
// A row is "live" (breathing dot) for this long after it was created.
const LIVE_WINDOW_MS = 30 * 1000;
// How often we refresh `now` so live/day-separator buckets stay honest.
const NOW_TICK_MS = 15_000;

// One feed item is either a single row or a collapsed burst of consecutive
// sibling rows (newest-first; `rows[0]` is the most recent in the burst).
interface FeedGroup {
  key: string;
  rows: ActivityRowData[];
}

// §2 connection-state copy. `dead` (>30s no heartbeat, per usePulseStream's
// watchdog) reads as a red "Reconnecting…" — a stalled stream is being retried,
// not permanently offline, and the watchdog runs alongside the backoff retry.
// The transient `reconnecting` (backoff in flight) shares the same wording but
// stays amber. Existing rows stay visible in every state; no modal, no toast.
const STATUS_META: Record<
  PulseConnectionStatus,
  { live: boolean; hue: string; label: string }
> = {
  connecting: { live: false, hue: 'text-status-warning-text', label: 'Connecting…' },
  connected: { live: true, hue: 'text-status-success-text', label: 'Live' },
  reconnecting: { live: false, hue: 'text-status-warning-text', label: 'Reconnecting…' },
  dead: { live: false, hue: 'text-status-danger-text', label: 'Reconnecting…' },
};

function rowTime(row: ActivityRowData): number {
  return new Date(row.createdAt).getTime();
}

/**
 * Collapse a newest-first row list into burst groups: consecutive rows that
 * share (clientId, briefId) and fall within BURST_WINDOW_MS of the previous row
 * in the run merge into one group. Null clientId never groups (we can't
 * attribute the burst to a single actor). Exported for unit-testing.
 */
export function groupRows(sortedDesc: ActivityRowData[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  for (const row of sortedDesc) {
    const last = groups[groups.length - 1];
    const head = last?.rows[last.rows.length - 1];
    const sameActor =
      !!head &&
      row.clientId !== null &&
      head.clientId === row.clientId &&
      head.briefId === row.briefId;
    const withinWindow =
      !!head && Math.abs(rowTime(head) - rowTime(row)) <= BURST_WINDOW_MS;

    if (last && sameActor && withinWindow) {
      last.rows.push(row);
    } else {
      groups.push({ key: row.id, rows: [row] });
    }
  }
  return groups;
}

export function ActivityFeed({
  rows,
  status,
  eventsLastHour = 0,
  loading = false,
  hasMore = false,
  onLoadOlder,
  contextBriefHandle,
  specTitle,
  isRegression,
  specHasActiveWorker,
}: ActivityFeedProps) {
  // Expanded burst groups, keyed by the group's lead-row id. Local to the feed.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // A slow tick so `now`-derived buckets (live window, day separators) refresh
  // without the parent having to re-render the whole feed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const meta = STATUS_META[status];

  // Newest-first, grouped into bursts. One continuous list under a single
  // "Event Log" header — no per-day separators (the relative "earlier today"
  // wording read oddly; the feed is an event log, full stop).
  const groups = useMemo<FeedGroup[]>(() => {
    const sorted = [...rows].sort((a, b) => rowTime(b) - rowTime(a));
    return groupRows(sorted);
  }, [rows]);

  // A stalled stream (>30s no heartbeat) recolours the whole status line red and
  // swaps the "N events" tail for a reconnect hint. Existing rows stay put.
  const disconnected = status === 'dead';

  return (
    <div className="flex h-full flex-col" data-testid="activity-feed">
      {/* Status line. */}
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs text-secondary border-b border-edge-subtle"
        {...(disconnected ? { 'data-testid': 'pulse-reconnecting' } : {})}
      >
        <LiveDot
          live={meta.live}
          size="sm"
          className={meta.hue}
          title={`Connection: ${meta.label.toLowerCase()}`}
        />
        <span className={`font-medium ${disconnected ? 'text-status-danger-text' : 'text-primary'}`}>
          {meta.label}
        </span>
        {!disconnected && (
          <>
            <span className="opacity-40">&middot;</span>
            <span>
              {eventsLastHour} event{eventsLastHour === 1 ? '' : 's'} in last hour
            </span>
          </>
        )}
      </div>

      {/* Scrollable feed. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && rows.length === 0 ? (
          <SkeletonRows />
        ) : groups.length === 0 ? (
          <EmptyFeed />
        ) : (
          <ol className="divide-y divide-edge-subtle/60">
            <li
              className="select-none px-3 py-2 text-center text-[0.65rem] uppercase tracking-wide text-muted/60"
              data-testid="event-log-header"
            >
              &middot; &middot; &middot; Event Log &middot; &middot; &middot;
            </li>
            {groups.map((group) => (
              <FeedRow
                key={group.key}
                group={group}
                now={now}
                contextBriefHandle={contextBriefHandle}
                specTitle={specTitle}
                isRegression={isRegression}
                specHasActiveWorker={specHasActiveWorker}
                expanded={expandedGroups.has(group.key)}
                onToggleExpand={() => toggleGroup(group.key)}
              />
            ))}
          </ol>
        )}

        {/* Backward paging. */}
        {hasMore ? (
          <div className="px-3 py-3 text-center">
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loading}
              data-testid="load-older"
              className="rounded border border-edge-subtle px-3 py-1 text-xs text-secondary hover:bg-card-hover hover:text-primary transition-colors disabled:opacity-60"
            >
              {loading ? 'Loading…' : 'Load older'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One feed line — either a single ActivityRow or, when the burst contains more
 * than one row, a collapsed group that expands into its members. Handles the
 * highlight-on-arrival tint for freshly-streamed rows (synthesised ids start
 * `live-`, per the stream's id convention in types.ts).
 */
function FeedRow({
  group,
  now,
  contextBriefHandle,
  specTitle,
  isRegression,
  specHasActiveWorker,
  expanded,
  onToggleExpand,
}: {
  group: FeedGroup;
  now: number;
  contextBriefHandle?: string;
  specTitle?: (handle: string) => string | undefined;
  isRegression?: (row: ActivityRowData) => boolean;
  specHasActiveWorker?: (briefId: string | null) => boolean;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const lead = group.rows[0];
  const isLive = (r: ActivityRowData) => now - rowTime(r) < LIVE_WINDOW_MS;
  // spec-122 ac-2: per-row regression + presence-aware muting.
  const regressed = (r: ActivityRowData) => isRegression?.(r) ?? false;
  const muted = (r: ActivityRowData) => specHasActiveWorker?.(r.briefId) ?? false;
  // SSE-synthesised rows carry a `live-` id prefix; those are the ones that
  // just arrived and get the one-shot arrival tint.
  const justArrived = lead.id.startsWith('live-');
  const arriveClass = justArrived ? 'animate-pulse-arrive' : '';

  if (group.rows.length > 1 && !expanded) {
    return (
      <li className={arriveClass}>
        <ActivityRow
          row={lead}
          isLive={isLive(lead)}
          contextBriefHandle={contextBriefHandle}
          specTitle={specTitle}
          groupCount={group.rows.length}
          expanded={false}
          onToggleExpand={onToggleExpand}
        />
      </li>
    );
  }

  if (group.rows.length > 1) {
    // Expanded: a "collapse" affordance on the lead, then each member row.
    return (
      <li className={arriveClass}>
        <ActivityRow
          row={lead}
          isLive={isLive(lead)}
          contextBriefHandle={contextBriefHandle}
          specTitle={specTitle}
          groupCount={group.rows.length}
          expanded
          onToggleExpand={onToggleExpand}
        />
        <ul className="border-l border-edge-subtle/60 ml-5">
          {group.rows.slice(1).map((r) => (
            <li key={r.id}>
              <ActivityRow
                row={r}
                isLive={isLive(r)}
                contextBriefHandle={contextBriefHandle}
                specTitle={specTitle}
                regressed={regressed(r)}
                regressionMuted={muted(r)}
              />
            </li>
          ))}
        </ul>
      </li>
    );
  }

  // Singleton.
  return (
    <li className={arriveClass}>
      <ActivityRow
        row={lead}
        isLive={isLive(lead)}
        contextBriefHandle={contextBriefHandle}
        specTitle={specTitle}
        regressed={regressed(lead)}
        regressionMuted={muted(lead)}
      />
    </li>
  );
}

// First-time empty state (§2): the feed has resolved with zero rows. A single
// idle (hollow) LiveDot as the "illustration" — same primitive as everywhere
// else, just at rest — over the "quiet so far" invitation. No motion; the dot
// only breathes once activity actually arrives.
function EmptyFeed() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      data-testid="pulse-empty"
    >
      <LiveDot live={false} size="lg" className="text-muted" />
      <p className="max-w-xs text-sm text-muted leading-relaxed">
        <span className="block font-medium text-secondary">Quiet so far.</span>
        Activity from your agents and teammates appears here as soon as anyone
        touches this Memex.
      </p>
    </div>
  );
}

// Skeleton placeholder rows for the initial load — a few two-line shells that
// echo the real row's shape (a dot+time line over a wider narrative line).
function SkeletonRows() {
  return (
    <ul className="divide-y divide-edge-subtle/60" data-testid="feed-skeleton">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-card-hover animate-pulse" />
            <span className="h-2 w-16 rounded bg-card-hover animate-pulse" />
          </div>
          <span className="mt-1.5 block h-3 w-3/4 rounded bg-card-hover animate-pulse" />
        </li>
      ))}
    </ul>
  );
}
