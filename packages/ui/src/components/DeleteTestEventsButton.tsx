// DeleteTestEventsButton — the X button at the end of a matrix row (b-96 t-5).
//
// Sits in the matrix row's trailing slot (via TestMatrix.renderRowAction).
// Clicking opens DeleteTestEventsDialog; confirming there fires the DELETE
// via api.discontinueAcTestEvents and then chains a parent-supplied
// `onDeleted` callback so the matrix can refetch.
//
// Per ac-5 / ac-9 the X button must not render for non-members. In practice
// the AC list itself is gated by membership (std-7 + sessionMiddleware), so
// in production this is always true. The `canDelete` prop exists so the
// matrix-row contract can express the suppression explicitly (and so tests
// can verify both branches).

import { useState } from 'react';
import { discontinueAcTestEvents } from '../api/client';
import { DeleteTestEventsDialog } from './DeleteTestEventsDialog';

interface DeleteTestEventsButtonProps {
  acId: string;
  testIdentifier: string;
  /** Exact emission count to pass into the confirmation wording (ac-7). */
  count: number;
  /** Hidden when the viewer is not a member of the AC's Memex. Default true. */
  canDelete?: boolean;
  /** Fired after a successful DELETE so the parent can refetch the matrix. */
  onDeleted: () => void | Promise<void>;
}

export function DeleteTestEventsButton({
  acId,
  testIdentifier,
  count,
  canDelete = true,
  onDeleted,
}: DeleteTestEventsButtonProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canDelete) return null;

  const handleConfirm = async (): Promise<void> => {
    try {
      await discontinueAcTestEvents(acId, testIdentifier);
      setError(null);
      setOpen(false);
      await onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Keep the dialog open so the user can retry or cancel; surface the
      // error inline beneath the X button so it's not lost.
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label={`Discontinue ${count} event${count === 1 ? '' : 's'} for ${testIdentifier || '(unnamed)'}`}
        onClick={() => setOpen(true)}
        className="rounded p-1 text-muted hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 transition-colors"
        data-testid="delete-test-events-button"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
      {error && (
        <span className="ml-1 text-xs text-rose-600 dark:text-rose-400" role="alert">
          {error}
        </span>
      )}
      {open && (
        <DeleteTestEventsDialog
          testIdentifier={testIdentifier}
          count={count}
          onConfirm={handleConfirm}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
