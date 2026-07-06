import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input } from './ui';
import {
  createVersion,
  CARRY_FORWARD_CLASSES,
  type CarryForwardClass,
  type DocumentVersionRow,
} from '../api/docs';

interface CreateVersionDialogProps {
  docId: string;
  onClose: () => void;
  /** Called after a successful cut so the caller can refetch the doc (the new
   *  version badge only shows once the doc's `version` is re-read, ac-1/ac-2). */
  onCreated: (row: DocumentVersionRow) => void;
}

// spec-448 t-8 (ac-1, ac-2): the create-version dialog — a required name plus
// the five prunable artifact-class checkboxes, all checked by default (a cut
// that carries EVERYTHING forward is the safe/expected default). Narrative
// sections always carry and are never a checkbox (dec-2) — stated as helper
// copy instead. Mirrors RenameSpecDialog's name-input shell (required text +
// Save/Cancel footer) and DownloadMdDialog's checkbox-list body.
const CLASS_LABELS: Record<CarryForwardClass, { label: string; description: string }> = {
  decisions: { label: 'Decisions', description: 'Resolved and open decisions' },
  acs: { label: 'Acceptance criteria', description: 'Scope and implementation ACs' },
  tasks: { label: 'Tasks', description: 'The task graph and its statuses' },
  issues: { label: 'Issues', description: 'Registered issues and their dispositions' },
  comments: { label: 'Comments', description: 'Discussion threads on sections, decisions, and tasks' },
};

export function CreateVersionDialog({ docId, onClose, onCreated }: CreateVersionDialogProps) {
  const [name, setName] = useState('');
  const [carryForward, setCarryForward] = useState<Record<CarryForwardClass, boolean>>({
    decisions: true,
    acs: true,
    tasks: true,
    issues: true,
    comments: true,
  });
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

  const toggle = (cls: CarryForwardClass) =>
    setCarryForward((prev) => ({ ...prev, [cls]: !prev[cls] }));

  const trimmedName = name.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trimmedName) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await createVersion(docId, {
        name: trimmedName,
        carryForward: CARRY_FORWARD_CLASSES.filter((cls) => carryForward[cls]),
      });
      onCreated(row);
      onClose();
    } catch (err) {
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
      >
        <div className="px-6 py-4 border-b border-edge flex items-center justify-between">
          <h2 className="text-base font-semibold text-heading">Create new version</h2>
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

        <div className="p-6 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="create-version-name" className="block text-xs font-medium uppercase tracking-wider text-muted">
              Version name
            </label>
            <Input
              id="create-version-name"
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Reviewed by legal"
              maxLength={200}
              disabled={submitting}
              required
              aria-required="true"
            />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Carry forward into the new version</p>
            <p className="text-xs text-muted">
              Narrative sections always carry forward. Uncheck a class below to freeze it in this
              cut but leave it out of the new working version.
            </p>
          </div>

          <div className="space-y-1">
            {CARRY_FORWARD_CLASSES.map((cls) => (
              <label
                key={cls}
                className="flex gap-3 items-start cursor-pointer px-3 py-2 rounded-lg hover:bg-overlay"
              >
                <input
                  type="checkbox"
                  checked={carryForward[cls]}
                  onChange={() => toggle(cls)}
                  disabled={submitting}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-primary">{CLASS_LABELS[cls].label}</div>
                  <div className="text-xs text-muted">{CLASS_LABELS[cls].description}</div>
                </div>
              </label>
            ))}
          </div>

          {error && <div className="text-sm text-status-danger-text">{error}</div>}
        </div>

        <div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={submitting || !trimmedName}>
            {submitting ? 'Creating…' : 'Create version'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
