// spec-566 t-7 (dec-7 / dec-10, ac-29) — the path forward when the done-gate refuses.
//
// WHY THIS COMPONENT IS THE POINT. spec-391 made verify→done a hard block at the
// same seam and it was reverted, because a refused drag just rolled the card
// back to its old column and said nothing. dec-10 chose the seam again on one
// condition: the refusal is typed, and the board turns it into THIS — a stated
// reason, a named act, and the move completing afterwards. spec-258 dec-5's
// guarantee is that an editor always has a web-UI path forward; this dialog is
// that path, and without it the guarantee is broken rather than re-mechanised.
//
// The reason is mandatory here as well as on the server. The server is the
// authority (a blank one is refused there), but a disabled button that explains
// itself is a better experience than a round-trip that comes back with an error,
// and dec-7 wants the override "designed, not improvised".

import { useState } from 'react';
import { overrideDoneGate } from '../../api/client';
import { Button } from '../ui';

interface Props {
  /** The Spec whose gate refused. */
  docId: string;
  /** The server's refusal — it names the criterion and the calls that clear it. */
  message: string;
  /** Called after the override lands, so the caller can complete the refused move. */
  onOverridden: () => void | Promise<void>;
  /** Dismiss without overriding; the card stays where it was. */
  onCancel: () => void;
}

export function DoneGateOverrideDialog({ docId, message, onOverridden, onCancel }: Props) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = reason.trim().length > 0;

  const submit = async () => {
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      await overrideDoneGate(docId, reason.trim());
      await onOverridden();
    } catch (e) {
      // The override failed, so the gate still stands. Say so and leave the
      // dialog open with the text intact — discarding a typed reason because a
      // request failed is how people learn to avoid the honest path.
      setError(e instanceof Error ? e.message : 'The override could not be recorded.');
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="done-gate-override-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="done-gate-override-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-[560px] max-w-full rounded-xl border border-edge bg-panel shadow-2xl">
        <div className="border-b border-edge px-5 py-3">
          <h2 id="done-gate-override-title" className="text-sm font-semibold text-heading">
            This Spec cannot close yet
          </h2>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm text-body">
          {/* The server's own words, verbatim. It names WHICH criterion and the
              exact calls that clear it [std-53]; paraphrasing here would drop
              the part that tells the reader what to do. */}
          <pre
            data-testid="done-gate-refusal"
            className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-overlay px-3 py-2 font-mono text-xs text-body"
          >
            {message}
          </pre>

          <div>
            <label htmlFor="done-gate-reason" className="mb-1 block font-medium text-heading">
              Close it anyway — why?
            </label>
            <p className="mb-2 text-xs text-muted">
              Recorded against your name, and counted beside this Spec&apos;s coverage
              from now on. Deciding the proposal is the ordinary path; this is the
              sanctioned way past the gate when neither accepting nor rejecting is right.
            </p>
            <textarea
              id="done-gate-reason"
              data-testid="done-gate-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-edge bg-panel px-3 py-2 text-sm text-primary"
              placeholder="e.g. the proposal is stale — the criterion is being retired under dec-4 next sprint"
            />
          </div>

          {error && (
            <p data-testid="done-gate-override-error" className="text-xs text-rose-600 dark:text-rose-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-edge px-5 py-3">
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            data-testid="done-gate-override-confirm"
            onClick={submit}
            disabled={!ready || submitting}
          >
            {submitting ? 'Recording…' : 'Override and close'}
          </Button>
        </div>
      </div>
    </div>
  );
}
