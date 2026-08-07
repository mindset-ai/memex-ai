// spec-521 t-4 (ac-4) — archiving asks WHY, and says plainly what it now does.
//
// This replaces a bare `window.confirm("Archive X? It'll be hidden from the board.")`
// followed by a `window.alert` on failure. Two things were wrong with that, and only
// one of them was the styling:
//
//  1. It asked for no REASON. Archive recorded a timestamp and nothing else, which
//     made it a black hole — "absorbed into spec-510" and "premise gone — voice loop
//     removed" are the difference between an archive and a disappearance, and they
//     are what make the archive view worth opening.
//
//  2. Its COPY described the old, smaller consequence. "Hidden from the board" was
//     true when archive was a tidying gesture. Since spec-521 dec-1/dec-2, archiving
//     also makes the Spec inert to every agent surface — Claude stops reading its
//     decisions and acceptance criteria entirely. The user's mental model has to
//     change with the behaviour, and the confirm is the only place that teaches it.
//
// std-34: this is a human surface, so no MCP tool is named and no MCP-only step is
// implied. It also does not suggest an agent could archive or restore — neither can
// (ac-16, dec-6); both directions of this switch are human-only.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input } from './ui';
import { archiveDoc } from '../api/client';

/** ac-4/ac-12: mirrors the server-side cap so the user is told before the request,
 *  not by a 400 afterwards. The server remains the enforcer. */
export const ARCHIVE_REASON_MAX_LENGTH = 280;

interface ArchiveSpecDialogProps {
  docId: string;
  title: string;
  onClose: () => void;
  onArchived?: (reason: string) => void;
}

export function ArchiveSpecDialog({
  docId,
  title,
  onClose,
  onArchived,
}: ArchiveSpecDialogProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await archiveDoc(docId, reason.trim() || undefined);
      onArchived?.(reason.trim());
      onClose();
    } catch (err) {
      // Inline, not window.alert: the dialog stays open with the reason the user
      // typed intact, so a failure costs them nothing.
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onClick={onClose}
    >
      <form
        className="w-full max-w-md rounded-xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-spec-dialog-title"
      >
        <div className="px-6 py-4 border-b border-edge flex items-center justify-between">
          <h2 id="archive-spec-dialog-title" className="text-base font-semibold text-heading">
            Archive spec
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-primary transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-6 space-y-3">
          <p className="text-sm text-primary">
            Archive <span className="font-medium text-heading">“{title}”</span>?
          </p>
          {/* ac-4: the sentence that teaches the new mental model. The old copy said
              only "hidden from the board", which no longer describes what archiving
              does. */}
          <p className="text-sm text-muted">
            Claude will stop reading this Spec entirely — its decisions and acceptance
            criteria included. You can restore it any time.
          </p>
          <label
            htmlFor="archive-spec-reason"
            className="block text-xs font-medium uppercase tracking-wider text-muted pt-1"
          >
            Reason
          </label>
          <Input
            id="archive-spec-reason"
            ref={inputRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={ARCHIVE_REASON_MAX_LENGTH}
            disabled={submitting}
            placeholder="e.g. absorbed into spec-510"
            aria-describedby="archive-spec-reason-hint"
          />
          <p id="archive-spec-reason-hint" className="text-xs text-muted">
            Shown in the archive view, so the next person knows why this was put down.
          </p>
          {error && <div className="text-sm text-status-danger-text">{error}</div>}
        </div>
        <div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="danger" disabled={submitting}>
            {submitting ? 'Archiving…' : 'Archive'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
