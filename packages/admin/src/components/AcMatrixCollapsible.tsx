// AcMatrixCollapsible — per-AC inline collapsible that lazy-fetches and
// renders the test-event matrix (b-96 t-4).
//
// Wraps `<TestMatrix>` and owns the open/closed state + the fetched data for
// a single AC row. Mounted once per AC inside the AC list (AcPanel). Multiple
// ACs can be expanded simultaneously; each component instance is independent.
//
// Per b-96 dec-16: the matrix lives inline as an accordion section inside
// the existing AC list. No new route, no modal, no use of the previous
// `investigate →` link.
//
// State machine:
//   closed  → no fetch, no render
//   opening → fetch in flight, "Loading…" placeholder
//   open    → matrix rendered; refetch on demand (t-5 will call this when
//             a DELETE completes so the row disappears without a page reload)
//
// We expose `onMatrixRefetchRequested` via the renderRowAction seam so the
// t-5 delete handler can chain a refetch after a successful DELETE.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAcTestMatrix,
  type AcTestMatrixRow,
} from '../api/client';
import { TestMatrix } from './TestMatrix';
import { DeleteTestEventsButton } from './DeleteTestEventsButton';

interface AcMatrixCollapsibleProps {
  acId: string;
  /** Pre-computed test count from the parent's `AcWithVerification` row so we
   *  can show "N tests" on the toggle without an extra round-trip. Falls back
   *  to "test history" when unspecified. */
  testCount?: number;
  /** Hides the X button on rows when false (per ac-5 / ac-9). The AC list
   *  itself is membership-gated so production callers can leave this true. */
  canDelete?: boolean;
  /** Override the default row action (the t-5 X button). Useful for tests
   *  and for surfaces that want to add their own per-row controls. */
  renderRowAction?: (row: AcTestMatrixRow, refetch: () => Promise<void>) => React.ReactNode;
}

export function AcMatrixCollapsible({
  acId,
  testCount,
  canDelete = true,
  renderRowAction,
}: AcMatrixCollapsibleProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AcTestMatrixRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guard against overlapping fetches on rapid open/close clicks.
  const fetchInFlight = useRef(false);

  const load = useCallback(async () => {
    if (fetchInFlight.current) return;
    fetchInFlight.current = true;
    try {
      const data = await fetchAcTestMatrix(acId);
      setRows(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      fetchInFlight.current = false;
    }
  }, [acId]);

  // Fetch on first open; subsequent opens reuse the cached state. The DELETE
  // flow (t-5) calls `refetch` explicitly through the renderRowAction seam.
  useEffect(() => {
    if (!open || rows !== null) return;
    void load();
  }, [open, rows, load]);

  const toggleLabel = open ? '▾ Hide test history' : '▸ Show test history';
  const counter =
    typeof testCount === 'number' && testCount > 0
      ? ` (${testCount} test${testCount === 1 ? '' : 's'})`
      : '';

  return (
    <div className="mt-2" data-testid="ac-matrix-collapsible" data-open={open}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-xs text-muted hover:text-primary transition-colors"
      >
        {toggleLabel}
        <span className="opacity-60">{counter}</span>
      </button>

      {open && (
        <div className="mt-2 rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
          {rows === null && error === null && (
            <p className="text-xs text-muted">Loading…</p>
          )}
          {error && (
            <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
          )}
          {rows !== null && (
            <TestMatrix
              rows={rows}
              renderRowAction={(row) => {
                if (renderRowAction) return renderRowAction(row, load);
                // Empty-identifier rows are an artefact of legacy NULL test
                // identifiers — they can't be uniquely deleted (the DELETE
                // requires a test_identifier value). Drop the X button so the
                // user can't try and silently fail.
                if (!row.testIdentifier) return null;
                return (
                  <DeleteTestEventsButton
                    acId={acId}
                    testIdentifier={row.testIdentifier}
                    count={row.emissions.length}
                    canDelete={canDelete}
                    onDeleted={load}
                  />
                );
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
