// spec-418 t-6 — the Create-tag dialog (dec-7). Opened by the surface's "New tag"
// button. Enter a `scope::value` or flat value; confirming mints a catalogue tag
// attached to no Spec (it starts at 0 Specs).
//
// Guarded by the DUPLICATE-NAME block ONLY (ac-29, dec-8): a name that already
// exists in any casing shows the plain reason inline and disables the confirm. It
// can NEVER show a per-scope exclusivity block — a brand-new catalogue tag is on
// no Spec, so that case structurally cannot arise here. No descriptive sub-header
// (ac-24): the only conditional text is the block reason.

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

interface TagCreateDialogProps {
  /** The current catalogue — drives the case-insensitive duplicate pre-check. */
  existingTags: readonly TagLike[];
  /** Mint the tag. Rejects (with the server's plain reason) to keep the dialog open. */
  onCreate: (input: { scope: string | null; value: string }) => Promise<void>;
  onClose: () => void;
}

export function TagCreateDialog({ existingTags, onCreate, onClose }: TagCreateDialogProps) {
  const [raw, setRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const parsed = useMemo(() => parseTagString(raw), [raw]);

  // The duplicate block is the ONLY guard on create (ac-29). Computed client-side
  // so the confirm disables before a round-trip; the server enforces it too.
  const duplicate = useMemo(
    () => (parsed.value ? findCiDuplicate(existingTags, parsed) : null),
    [existingTags, parsed],
  );

  const blockReason = duplicate
    ? `A tag named "${formatTagString(duplicate)}" already exists`
    : serverError;

  const canConfirm = parsed.value.length > 0 && !duplicate && !serverError && !submitting;

  async function handleConfirm() {
    if (!canConfirm) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await onCreate({ scope: parsed.scope, value: parsed.value });
      onClose();
    } catch (err) {
      // Revert-with-reason (ac-36): the optimistic add is undone by the caller;
      // we keep the dialog open and surface the server's plain reason (ac-34).
      setServerError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <TagDialogShell
      title="New tag"
      testId="tag-create-dialog"
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
            {submitting ? 'Creating…' : 'Create tag'}
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
        <label htmlFor="tag-create-input" className="block text-xs font-medium uppercase tracking-wider text-muted">
          Tag
        </label>
        <Input
          id="tag-create-input"
          data-testid="tag-dialog-input"
          data-autofocus
          value={raw}
          placeholder="scope::value or a flat value"
          onChange={(e) => {
            setRaw(e.target.value);
            setServerError(null);
          }}
          maxLength={260}
          aria-invalid={blockReason ? true : undefined}
          aria-describedby={blockReason ? 'tag-create-block' : undefined}
        />
        {blockReason && (
          <p id="tag-create-block" role="alert" data-testid="tag-dialog-block" className="text-sm text-status-danger-text">
            {blockReason}
          </p>
        )}
      </form>
    </TagDialogShell>
  );
}
