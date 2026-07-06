// spec-418 t-6 — the Delete-tag confirm. Delete NEVER blocks (ac-15); the confirm
// only names the blast radius before removing.
//
// Copy is load-bearing only (ac-24): a tag still on N Specs shows "Still in use on
// N Specs" and the button reads "Delete from N Specs"; a 0-Spec tag drops the
// warning entirely and reads simply "Delete". Deleting unlinks the tag from those
// Specs — the Specs themselves are untouched. The named post-delete confirmation
// toast ("Deleted '…' from N Specs", ac-36) is raised by the surface, not here.

import { useState } from 'react';
import { Button } from './ui';
import { TagDialogShell, formatTagString } from './TagDialogShell';

interface TagLike {
  id: string;
  scope: string | null;
  value: string;
  assignedCount: number;
}

interface TagDeleteDialogProps {
  tag: TagLike;
  /** Remove the tag. Rejects (with the server's plain reason) to keep the dialog
   *  open and surface the failure (ac-34). */
  onDelete: () => Promise<void>;
  onClose: () => void;
}

export function TagDeleteDialog({ tag, onDelete, onClose }: TagDeleteDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const n = tag.assignedCount;
  const inUse = n > 0;
  const label = formatTagString(tag);

  async function handleDelete() {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <TagDialogShell
      title="Delete tag"
      testId="tag-delete-dialog"
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="tag-dialog-cancel"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            data-testid="tag-dialog-confirm"
            onClick={() => void handleDelete()}
            disabled={submitting}
          >
            {submitting ? 'Deleting…' : inUse ? `Delete from ${n} Spec${n === 1 ? '' : 's'}` : 'Delete'}
          </Button>
        </>
      }
    >
      <p data-testid="tag-delete-prompt" className="text-sm text-body">
        Delete <span className="font-medium text-heading">{label}</span>?
      </p>
      {inUse && (
        <p data-testid="tag-delete-blast" className="text-sm text-status-warning-text">
          Still in use on {n} Spec{n === 1 ? '' : 's'} — deleting removes it from{' '}
          {n === 1 ? 'that Spec' : 'those Specs'} (the Spec{n === 1 ? '' : 's'} stay).
        </p>
      )}
      {serverError && (
        <p role="alert" data-testid="tag-dialog-block" className="text-sm text-status-danger-text">
          {serverError}
        </p>
      )}
    </TagDialogShell>
  );
}
