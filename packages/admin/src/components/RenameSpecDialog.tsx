import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input } from './ui';
import { updateDocTitle } from '../api/client';

interface RenameSpecDialogProps {
  docId: string;
  currentTitle: string;
  onClose: () => void;
  onRenamed?: (newTitle: string) => void;
}

export function RenameSpecDialog({
  docId,
  currentTitle,
  onClose,
  onRenamed,
}: RenameSpecDialogProps) {
  const [title, setTitle] = useState(currentTitle);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus + select-all so the user can either edit in place or retype over.
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
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
    const trimmed = title.trim();
    if (!trimmed || trimmed === currentTitle.trim()) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await updateDocTitle(docId, trimmed);
      onRenamed?.(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        className="w-full max-w-md rounded-xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="px-6 py-4 border-b border-edge flex items-center justify-between">
          <h2 className="text-base font-semibold text-heading">Rename spec</h2>
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
          <label className="block text-xs font-medium uppercase tracking-wider text-muted">
            Title
          </label>
          <Input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={500}
            disabled={submitting}
          />
          {error && (
            <div className="text-sm text-status-danger-text">{error}</div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
