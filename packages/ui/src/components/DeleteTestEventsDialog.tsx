// DeleteTestEventsDialog — confirmation modal for permanently deleting every
// emission for one (acId, testIdentifier) pair (b-96 t-5 / dec-13).
//
// The wording is load-bearing: "Permanently delete N events for this test?
// It will only reappear if it next emits." The explicit emission count (N)
// is required by ac-7; the second sentence frames the irreversibility-with-
// graceful-recovery contract (deleted rows are gone, but a fresh test_event
// will re-create the row from scratch).
//
// Confirmation requires a deliberate "Delete" button click. Cancel button,
// Escape key, and backdrop click all close the dialog WITHOUT issuing the
// DELETE — the friction is a deliberate UX trade-off (per dec-13).
//
// spec-566 t-4 adds a REQUIRED reason. The emissions are still hard-deleted; what
// changes is that the act now leaves a durable, named receipt instead of an
// `activity_log` line reading "ac updated" that expires after 30 days. Delete
// stays disabled until the reason is non-blank — the server refuses a blank one
// anyway, and discovering that after clicking Delete on an irreversible action is
// the wrong place to learn it.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface DeleteTestEventsDialogProps {
  testIdentifier: string;
  count: number;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}

export function DeleteTestEventsDialog({
  testIdentifier,
  count,
  onConfirm,
  onClose,
}: DeleteTestEventsDialogProps): React.ReactPortal {
  const [submitting, setSubmitting] = useState(false);
  const [reason, setReason] = useState('');
  const reasonReady = reason.trim().length > 0;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (submitting) return;
      if (e.key === 'Escape') onClose();
    },
    [onClose, submitting],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleConfirm = async (): Promise<void> => {
    if (submitting) return;
    if (!reasonReady) return;
    setSubmitting(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setSubmitting(false);
    }
  };

  // The exact wording required by ac-7 + dec-13. N is the precise emission
  // count — never rounded, never "all" or "this test's events".
  const prompt = `Permanently delete ${count} ${count === 1 ? 'event' : 'events'} for this test? It will only reappear if it next emits.`;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-test-events-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
      onClick={(e) => {
        // Backdrop click closes — same friction-aware behaviour as Cancel.
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-[440px] max-w-[92vw] rounded-xl border border-edge bg-panel shadow-2xl">
        <div className="px-5 py-4 border-b border-edge">
          <h2
            id="delete-test-events-title"
            className="text-sm font-semibold text-heading"
          >
            Discontinue test events
          </h2>
        </div>
        <div className="px-5 py-4 text-sm text-body space-y-3">
          <p>{prompt}</p>
          <p className="font-mono text-xs text-muted truncate" title={testIdentifier}>
            {testIdentifier || '(unnamed)'}
          </p>
          <div className="space-y-1.5">
            <label
              htmlFor="delete-test-events-reason"
              className="block text-xs font-medium text-heading"
            >
              Why is this being retired?
            </label>
            <textarea
              id="delete-test-events-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              rows={3}
              placeholder="What happened to the test — renamed, deleted, moved, replaced by another test?"
              className="w-full rounded-md border border-edge bg-panel px-2.5 py-1.5 text-sm text-body placeholder:text-muted focus:outline-hidden focus:ring-2 focus:ring-rose-500/40 disabled:opacity-50"
              data-testid="delete-test-events-reason"
            />
            <p className="text-xs text-muted">
              Kept with the retirement, alongside who did it and the commit the
              deleted evidence ran against.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-edge">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm rounded-md text-muted hover:bg-overlay disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={submitting || !reasonReady}
            title={reasonReady ? undefined : 'Give a reason first'}
            className="px-3 py-1.5 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {submitting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
