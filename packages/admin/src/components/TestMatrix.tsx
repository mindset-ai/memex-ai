// TestMatrix — per-AC test-event history rendered on a shared time axis (b-96).
//
// Pure rendering. Takes the `AcTestMatrixRow[]` response from
// `fetchAcTestMatrix(acId)` as a prop and renders rows of test_identifiers
// with their emissions positioned by `emittedAt` along a SHARED time axis.
//
// Design (refines b-96 dec-11 — "one column per emission, no run-batching" —
// without violating it):
//
//   • Right edge = now. Left edge = oldest visible emission across all rows
//     (with a minimum span of 24h so dense-in-one-hour matrices don't
//     collapse to a sliver).
//   • Per-row cap: most recent N emissions where
//         N = max(10, count_in_last_30d)
//     so a sparsely-emitted test always shows its last 10 (the axis
//     stretches to fit them), and a busy test shows everything it emitted
//     in the last 30 days. Anything older than that is dropped silently;
//     a `+N older` affordance is deferred to a follow-up.
//   • Each emission is its own square positioned by its `emittedAt`. No
//     run-batching, no inferred "didn't run" greys — squares only exist
//     for real emissions.
//   • Min spacing between adjacent squares prevents dense CI bursts from
//     visually merging into a blob.
//   • Empty space to the right of a row's rightmost square IS the
//     "stopped" signal: that gap is the time since this test last emitted.
//
// The native `title` is kept on each square as an accessibility / overflow
// fallback alongside the snappy CSS hover tooltip.

import type {
  AcTestMatrixRow,
  TestEventStatus,
  TestMatrixEmission,
} from '../api/client';

// ── Layout constants. Strip width is fixed so time-axis positioning stays
//   deterministic across container widths; the identifier column (grid 1fr)
//   absorbs any extra room.
const STRIP_WIDTH_PX = 300;
const SQUARE_WIDTH_PX = 12;
const MIN_SQUARE_GAP_PX = 4;

// ── Window / capping rules.
const ROW_CAP = 10;
const DEFAULT_WINDOW_DAYS = 30;
const MIN_AXIS_HOURS = 24;

interface TestMatrixProps {
  rows: AcTestMatrixRow[];
  /** Optional: render a per-row trailing slot (the X button in t-5). The
   *  callback receives the row so the slot can wire `testIdentifier` into
   *  the click handler. Returning `null` opts out for individual rows
   *  (e.g. the empty-identifier bucket the user shouldn't delete). */
  renderRowAction?: (row: AcTestMatrixRow) => React.ReactNode;
  /** Override the "now" reference for deterministic tests. Defaults to
   *  Date.now() at render time. */
  now?: number;
}

// Matches the warm-but-distinct palette established in AcPanel.tsx: green for
// pass, the same softer rose for fail (not strident red-500), amber for the
// rarer `error` state so it reads as "anomaly" rather than "assertion failed".
const STATUS_COLOUR: Record<TestEventStatus, string> = {
  pass: 'bg-green-500',
  fail: 'bg-rose-500',
  error: 'bg-amber-500',
};

const STATUS_LABEL: Record<TestEventStatus, string> = {
  pass: 'pass',
  fail: 'fail',
  error: 'error',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

// ── Pure helpers (exported for unit testing). ──────────────────────────────

/**
 * Pick the emissions to render for one row.
 *
 * Per-row cap: most recent N emissions where N = max(ROW_CAP, count_in_last_30d).
 * Server delivers emissions DESC by `emittedAt`, so we walk the head of the
 * array and count until we drop out of the 30d window.
 */
export function selectVisibleEmissions(
  emissions: TestMatrixEmission[],
  now: number,
): TestMatrixEmission[] {
  if (emissions.length === 0) return [];
  const cutoff = now - DEFAULT_WINDOW_DAYS * MS_PER_DAY;
  let countInWindow = 0;
  for (const em of emissions) {
    if (new Date(em.emittedAt).getTime() >= cutoff) countInWindow += 1;
    else break;
  }
  const take = Math.max(ROW_CAP, countInWindow);
  return emissions.slice(0, take);
}

export interface MatrixWindow {
  startMs: number;
  endMs: number;
}

/**
 * Compute the shared time axis window across all rows.
 *
 * Right edge = `now`. Left edge = the oldest visible emission across all
 * rows OR `now - 30d`, whichever is older. A minimum span of 24h prevents
 * the axis collapsing to a sliver when every emission landed in the same hour.
 */
export function computeMatrixWindow(
  rows: AcTestMatrixRow[],
  now: number,
): MatrixWindow {
  const defaultStart = now - DEFAULT_WINDOW_DAYS * MS_PER_DAY;
  let oldest = defaultStart;
  for (const row of rows) {
    const visible = selectVisibleEmissions(row.emissions, now);
    for (const em of visible) {
      const t = new Date(em.emittedAt).getTime();
      if (t < oldest) oldest = t;
    }
  }
  const minStart = now - MIN_AXIS_HOURS * MS_PER_HOUR;
  return { startMs: Math.min(oldest, minStart), endMs: now };
}

interface PositionedEmission {
  status: TestEventStatus;
  emittedAt: string;
  /** Left offset in px from the strip's left edge. */
  leftPx: number;
  actor?: string | null;
  metadata?: Record<string, string> | null;
}

/**
 * Position each emission on the strip.
 *
 * Newest emissions get their natural X (proportional to emittedAt within the
 * window). Older ones may be pushed left to maintain at least
 * MIN_SQUARE_GAP_PX between adjacent squares so dense CI bursts don't merge
 * into a single blob. If pushing left would fall off the strip's left edge,
 * the rest of the (older) emissions are dropped — the "+N older" affordance
 * lives in a follow-up.
 *
 * Input MUST be DESC by emittedAt (newest first) so the spacing rule walks
 * in the right direction.
 */
export function positionEmissions(
  emissions: TestMatrixEmission[],
  window: MatrixWindow,
  stripWidth: number = STRIP_WIDTH_PX,
  squareWidth: number = SQUARE_WIDTH_PX,
  minGap: number = MIN_SQUARE_GAP_PX,
): PositionedEmission[] {
  if (emissions.length === 0) return [];
  const span = Math.max(1, window.endMs - window.startMs);
  const maxLeft = Math.max(0, stripWidth - squareWidth);
  const positioned: PositionedEmission[] = [];
  let prevLeft = Number.POSITIVE_INFINITY;
  for (const em of emissions) {
    const t = new Date(em.emittedAt).getTime();
    const naturalLeft = ((t - window.startMs) / span) * maxLeft;
    let left = Math.max(0, Math.min(maxLeft, naturalLeft));
    const maxAllowedByPrev = prevLeft - (squareWidth + minGap);
    if (left > maxAllowedByPrev) left = maxAllowedByPrev;
    if (left < 0) break;
    positioned.push({
      status: em.status,
      emittedAt: em.emittedAt,
      leftPx: left,
      actor: em.actor,
      metadata: em.metadata,
    });
    prevLeft = left;
  }
  return positioned;
}

// ── Rendering ──────────────────────────────────────────────────────────────

// spec-115 v0.1.0: well-known metadata keys render in a specific order and
// receive special treatment in the tooltip. Unknown customer-defined keys
// render after them as plain key: value pairs.
//
// spec-115 dec-6: `actor` is NOT in this list — it's a top-level wire-format
// field (sibling of `hidden` and `metadata`) per the spec-122 activity
// contract, not a metadata key. The tooltip renders actor in its own header
// slot just below the status/timestamp.
const WELL_KNOWN_KEYS = [
  'branch',
  'commit',
  'host',
  'run_id',
  'run_url',
] as const;

const MAX_TOOLTIP_KEYS = 12;

function orderMetadataKeys(metadata: Record<string, string>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of WELL_KNOWN_KEYS) {
    if (key in metadata) {
      ordered.push(key);
      seen.add(key);
    }
  }
  for (const key of Object.keys(metadata).sort()) {
    if (!seen.has(key)) ordered.push(key);
  }
  return ordered;
}

function formatMetadataValue(key: string, value: string): string {
  // Trim 7-char commit hash for visual compactness; the full value remains
  // readable via the underlying title attribute for accessibility.
  if (key === 'commit' && value.length > 7) return value.slice(0, 7);
  return value;
}

function EmissionSquare({
  status,
  emittedAt,
  actor,
  metadata,
  leftPx,
}: {
  status: TestEventStatus;
  emittedAt: string;
  actor?: string | null;
  metadata?: Record<string, string> | null;
  leftPx: number;
}): React.ReactElement {
  const headerLine = `${STATUS_LABEL[status]} · ${new Date(emittedAt).toLocaleString()}`;
  // spec-115 ac-3: surface metadata in the tooltip. Well-known keys come
  // first in a documented order; unknown keys after. Cap the rendered set
  // at MAX_TOOLTIP_KEYS so a runaway metadata bag can't blow up the UI.
  const orderedKeys = metadata ? orderMetadataKeys(metadata) : [];
  const visibleKeys = orderedKeys.slice(0, MAX_TOOLTIP_KEYS);
  const hiddenCount = orderedKeys.length - visibleKeys.length;
  // spec-115 dec-6: actor is a top-level field. Render it in its own slot
  // (separate from the metadata block) so it stays visible even when no
  // other metadata is present.
  const actorLine = actor ? `actor: ${actor}` : null;
  const titleText = [
    headerLine,
    ...(actorLine ? [actorLine] : []),
    ...(metadata
      ? [
          ...visibleKeys.map(
            (k) => `${k}: ${formatMetadataValue(k, metadata[k])}`,
          ),
          ...(hiddenCount > 0 ? [`+${hiddenCount} more`] : []),
        ]
      : []),
  ].join('\n');

  return (
    <span
      className="group/sq absolute inline-block"
      style={{ left: leftPx, top: 0 }}
    >
      <span
        role="img"
        aria-label={titleText}
        title={titleText}
        data-status={status}
        data-emitted-at={emittedAt}
        className={`block rounded-sm ${STATUS_COLOUR[status]}`}
        style={{ width: SQUARE_WIDTH_PX, height: SQUARE_WIDTH_PX }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium text-zinc-100 opacity-0 shadow-sm transition-opacity group-hover/sq:opacity-100 dark:bg-zinc-100 dark:text-zinc-900"
      >
        <span className="whitespace-nowrap">{headerLine}</span>
        {actor && (
          <span
            data-testid="emission-actor"
            className="mt-0.5 block whitespace-nowrap border-t border-zinc-700 pt-0.5 dark:border-zinc-300"
          >
            <span className="opacity-70">actor: </span>
            <span>{actor}</span>
          </span>
        )}
        {visibleKeys.length > 0 && (
          <span
            data-testid="emission-metadata"
            className={`block text-left ${actor ? 'mt-0' : 'mt-0.5 border-t border-zinc-700 pt-0.5 dark:border-zinc-300'}`}
          >
            {visibleKeys.map((k) => (
              <span
                key={k}
                data-metadata-key={k}
                className="block whitespace-nowrap"
              >
                {k === 'run_url' && metadata ? (
                  <>
                    <span className="opacity-70">{k}: </span>
                    <span className="underline">{metadata[k]}</span>
                  </>
                ) : (
                  <>
                    <span className="opacity-70">{k}: </span>
                    <span>{formatMetadataValue(k, metadata![k])}</span>
                  </>
                )}
              </span>
            ))}
            {hiddenCount > 0 && (
              <span className="block whitespace-nowrap opacity-70">
                +{hiddenCount} more
              </span>
            )}
          </span>
        )}
      </span>
    </span>
  );
}

function formatAxisDate(ms: number): string {
  // Short locale date; "today" anchors the right edge, so the left label
  // mainly tells you how wide the window is.
  return new Date(ms).toLocaleDateString();
}

export function TestMatrix({
  rows,
  renderRowAction,
  now: nowProp,
}: TestMatrixProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No events recorded for this AC.
      </p>
    );
  }

  const now = nowProp ?? Date.now();
  const window = computeMatrixWindow(rows, now);
  const startLabel = formatAxisDate(window.startMs);

  // Grid layout keeps the strip column and the axis labels precisely aligned
  // regardless of how wide the identifier or action columns are. `display:
  // contents` on each row wrapper lets the wrapper carry test/data attributes
  // while its three children participate directly in the parent grid.
  return (
    <div>
      <div
        className="grid items-center gap-x-3 gap-y-1.5"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) auto auto' }}
      >
        {rows.map((row) => {
          const visible = selectVisibleEmissions(row.emissions, now);
          const positioned = positionEmissions(visible, window);
          return (
            <div
              key={row.testIdentifier || '__empty__'}
              data-testid="test-matrix-row"
              data-test-identifier={row.testIdentifier}
              className="contents"
            >
              <span
                className="min-w-0 truncate font-mono text-xs text-zinc-600 dark:text-zinc-300"
                title={row.testIdentifier}
              >
                {row.testIdentifier || <em className="text-zinc-400">(unnamed)</em>}
              </span>
              <div
                className="relative"
                style={{ width: STRIP_WIDTH_PX, height: SQUARE_WIDTH_PX }}
                data-testid="test-matrix-strip"
              >
                {positioned.map((em, idx) => (
                  // Composite key: a test_identifier can have many emissions
                  // at the same millisecond in seeded tests. Index fallback is
                  // fine because emissions never reorder in-place (the input
                  // array is server-sorted DESC and treated as immutable).
                  <EmissionSquare
                    key={`${em.emittedAt}-${idx}`}
                    status={em.status}
                    emittedAt={em.emittedAt}
                    actor={em.actor}
                    metadata={em.metadata}
                    leftPx={em.leftPx}
                  />
                ))}
              </div>
              <span className="shrink-0">
                {renderRowAction ? renderRowAction(row) : null}
              </span>
            </div>
          );
        })}
        {/* Axis row — labels span the strip column, with empty placeholders
            in the identifier + action columns so the grid keeps them aligned
            with the strip's left + right edges. Text size matches the
            sparkline's axis labels so the two visual idioms read as
            siblings ("right = now, left = the past"). */}
        <span aria-hidden />
        <div
          className="mt-1.5 flex justify-between text-xs text-muted"
          data-testid="test-matrix-axis"
        >
          <span>{startLabel}</span>
          <span>today</span>
        </div>
        <span aria-hidden />
      </div>
    </div>
  );
}
