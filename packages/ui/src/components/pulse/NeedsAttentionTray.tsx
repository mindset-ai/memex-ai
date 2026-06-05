import type { ComponentType } from 'react';
import {
  useNeedsAttention,
  type AttentionSlice,
  type NeedsAttentionData,
} from './tray/useNeedsAttention';
import { UnresolvedDecisionsTile } from './tray/UnresolvedDecisionsTile';
import { OpenQuestionsTile } from './tray/OpenQuestionsTile';
import { DriftSignalsTile } from './tray/DriftSignalsTile';
import { BlockedTasksTile } from './tray/BlockedTasksTile';

/**
 * NeedsAttentionTray — the right-column "Needs attention" tray for Pulse
 * (b-60, Wave 2). Composes the four tiles (unresolved decisions, open
 * questions, drift signals, blocked tasks) over the shared
 * {@link useNeedsAttention} hook.
 *
 * PRESENTATIONAL + PLUGGABLE: every tile is described by a {@link TrayTile}
 * entry in the `TILES` array and rendered generically — a fifth tile is a
 * one-line config addition (point its `select` at a new slice, supply its
 * component). Each tile component is itself presentational and takes its data
 * via props, so the tray stays a thin orchestration shell.
 *
 * Scope (per dec-9): when `briefId` is set the underlying hook narrows every
 * tile to that one Spec; otherwise it surfaces memex-wide signals. The prop
 * name stays `briefId` for wire compatibility with the server.
 */

/** Props each pluggable tile component must accept. */
export interface TrayTileComponentProps {
  data: AttentionSlice;
}

/**
 * One pluggable tile: which slice of the hook's data feeds it, and the
 * component that renders that slice. Add a fifth tile by appending an entry.
 */
export interface TrayTile {
  /** Stable key for the rendered list. */
  key: string;
  /** Pick this tile's slice out of the full hook payload. */
  select: (data: NeedsAttentionData) => AttentionSlice;
  /** The presentational component for this tile. */
  Component: ComponentType<TrayTileComponentProps>;
}

/**
 * The tray's tile registry. Order here is render order, top-to-bottom. A future
 * fifth signal lands as one more entry — no changes to the tray body.
 */
export const TILES: TrayTile[] = [
  {
    key: 'decisions',
    select: (d) => d.unresolvedDecisions,
    Component: UnresolvedDecisionsTile,
  },
  {
    key: 'questions',
    select: (d) => d.openQuestions,
    Component: OpenQuestionsTile,
  },
  {
    key: 'drift',
    select: (d) => d.driftSignals,
    Component: DriftSignalsTile,
  },
  {
    key: 'blocked-tasks',
    select: (d) => d.blockedTasks,
    Component: BlockedTasksTile,
  },
];

export interface NeedsAttentionTrayProps {
  /** When set, every tile narrows to this Spec (dec-9). Omit for memex-wide. */
  briefId?: string;
  /**
   * Tile registry override — defaults to {@link TILES}. Exposed so the page (or
   * a test) can reorder / add / drop tiles without forking the tray.
   */
  tiles?: TrayTile[];
}

export function NeedsAttentionTray({
  briefId,
  tiles = TILES,
}: NeedsAttentionTrayProps) {
  const attention = useNeedsAttention(briefId);
  const { loading, error } = attention;
  // The hook result extends NeedsAttentionData, so it already carries the four
  // slices each tile's `select` reads.
  const payload: NeedsAttentionData = attention;

  // First paint (§2): the hook starts loading with every slice empty. While that
  // initial fetch is in flight and nothing has resolved yet, show shimmer tiles
  // instead of empty real ones — one per registered tile, so the column doesn't
  // jump. A *refresh* (data already present) keeps the live tiles and shows the
  // quiet "Refreshing…" line below instead. No spinner.
  const firstPaint =
    loading && tiles.every(({ select }) => select(payload).count === 0);

  return (
    <aside
      className="flex flex-col gap-3"
      aria-label="Needs attention"
      data-testid="needs-attention-tray"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
        Needs attention
      </h2>

      {error && (
        <div className="rounded-md border border-status-danger-border bg-status-danger-bg p-2 text-xs text-status-danger-text">
          {error}
        </div>
      )}

      {firstPaint
        ? tiles.map(({ key }) => <TrayTileSkeleton key={key} />)
        : tiles.map(({ key, select, Component }) => (
            <Component key={key} data={select(payload)} />
          ))}

      {loading && !firstPaint && (
        <p className="text-xs text-muted" data-testid="tray-loading">
          Refreshing…
        </p>
      )}
    </aside>
  );
}

// Shimmer placeholder for one tray tile during first paint (§2). Echoes the real
// tile's frame (header row + count badge + two item lines) with muted bars that
// pulse via Tailwind's `animate-pulse` — the same skeleton idiom the feed uses.
// NOT the LiveDot heartbeat: this is a loading shell, not a "live" indicator.
function TrayTileSkeleton() {
  return (
    <section
      className="rounded-lg border border-edge bg-card-hover/40 p-3"
      data-testid="tray-tile-skeleton"
      aria-hidden="true"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-card-hover animate-pulse" />
          <span className="h-2.5 w-24 rounded bg-card-hover animate-pulse" />
        </div>
        <span className="h-5 w-5 rounded-full bg-card-hover animate-pulse" />
      </div>
      <div className="space-y-1.5">
        <span className="block h-3 w-3/4 rounded bg-card-hover animate-pulse" />
        <span className="block h-3 w-1/2 rounded bg-card-hover animate-pulse" />
      </div>
    </section>
  );
}
