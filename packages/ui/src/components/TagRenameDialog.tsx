// spec-418 t-6 — the Rename-tag dialog. A single field editing the tag's
// `scope::value`; every Spec carrying it follows the new name.
//
// Guarded, not clever (dec-3). Two block cases, both surfaced inline with a plain
// reason and a disabled confirm (ac-24 — no descriptive sub-header, only the block
// reason):
//   (a) DUPLICATE — the new name collides (case-insensitively, dec-8) with another
//       tag. Detected client-side so the confirm disables before a round-trip.
//   (b) SCOPE-EXCLUSIVITY — the new scope would leave a Spec holding two values in
//       one scope. This needs per-Spec data the client doesn't have, so it can only
//       come back from the server: on a blocked submit we show the reason inline,
//       keep the dialog open, and disable the confirm until the field changes.

import { useMemo, useState } from 'react';
import { Button, Input } from './ui';
import {
  TagDialogShell,
  parseTagString,
  formatTagString,
  findCiDuplicate,
} from './TagDialogShell';

interface TagLike {
  id: string;
  scope: string | null;
  value: string;
}

interface TagRenameDialogProps {
  /** The tag being renamed. */
  tag: TagLike;
  /** The full catalogue — drives the case-insensitive duplicate pre-check. */
  existingTags: readonly TagLike[];
  /** Apply the rename. Rejects (with the server's plain reason — duplicate OR
   *  scope-exclusivity) to keep the dialog open and surface the block. */
  onRename: (input: { scope: string | null; value: string }) => Promise<void>;
  onClose: () => void;
}

export function TagRenameDialog({ tag, existingTags, onRename, onClose }: TagRenameDialogProps) {
  const original = formatTagString(tag);
  const [raw, setRaw] = useState(original);
  const [submitting, setSubmitting] = useState(false);
  // The last server-returned block (scope-exclusivity or a duplicate race). Cleared
  // whenever the field changes, so an edited name gets a fresh attempt.
  const [serverError, setServerError] = useState<string | null>(null);

  const parsed = useMemo(() => parseTagString(raw), [raw]);
  const unchanged = raw.trim() === original;

  const duplicate = useMemo(
    () => (parsed.value && !unchanged ? findCiDuplicate(existingTags, parsed, tag.id) : null),
    [existingTags, parsed, tag.id, unchanged],
  );

  const blockReason = duplicate
    ? `A tag named "${formatTagString(duplicate)}" already exists`
    : serverError;

  const canConfirm =
    parsed.value.length > 0 && !unchanged && !duplicate && !serverError && !submitting;

  async function handleConfirm() {
    if (!canConfirm) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await onRename({ scope: parsed.scope, value: parsed.value });
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <TagDialogShell
      title="Rename tag"
      testId="tag-rename-dialog"
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
            size="sm"
            data-testid="tag-dialog-confirm"
            disabled={!canConfirm}
            onClick={() => void handleConfirm()}
          >
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleConfirm();
        }}
        className="space-y-3"
      >
        <label htmlFor="tag-rename-input" className="block text-xs font-medium uppercase tracking-wider text-muted">
          Tag
        </label>
        <Input
          id="tag-rename-input"
          data-testid="tag-dialog-input"
          data-autofocus
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setServerError(null);
          }}
          maxLength={260}
          aria-invalid={blockReason ? true : undefined}
          aria-describedby={blockReason ? 'tag-rename-block' : undefined}
        />
        {blockReason && (
          <p id="tag-rename-block" role="alert" data-testid="tag-dialog-block" className="text-sm text-status-danger-text">
            {blockReason}
          </p>
        )}
      </form>
    </TagDialogShell>
  );
}
