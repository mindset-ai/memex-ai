// spec-300 t-16 (dec-24, ac-55/ac-58) — the confirmation guard for removing an
// auxiliary file from a Skill. Removing a file is destructive (the blob + its
// manifest row are dropped), so a deliberate confirmation stands between a click on
// the row's X and the actual delete — a fat-finger can't ruin a skill.
//
// Cancel button, Escape key, and backdrop click all close WITHOUT removing —
// mirrors the DeleteTestEventsDialog convention.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface RemoveSkillFileDialogProps {
  /** The auxiliary-file path being removed (shown so the user confirms the right one). */
  path: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function RemoveSkillFileDialog({
  path,
  onConfirm,
  onClose,
}: RemoveSkillFileDialogProps): React.ReactPortal {
  const [submitting, setSubmitting] = useState(false);

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
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-skill-file-title"
      data-testid="remove-skill-file-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-[440px] max-w-[92vw] rounded-xl border border-edge bg-panel shadow-2xl">
        <div className="px-5 py-4 border-b border-edge">
          <h2 id="remove-skill-file-title" className="text-sm font-semibold text-heading">
            Remove auxiliary file
          </h2>
        </div>
        <div className="px-5 py-4 text-sm text-body space-y-3">
          <p>Remove this file from the skill? This can’t be undone.</p>
          <p className="font-mono text-xs text-muted truncate" title={path}>
            {path}
          </p>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-edge">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            data-testid="remove-skill-file-cancel"
            className="px-3 py-1.5 text-sm rounded-md text-muted hover:bg-overlay disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={submitting}
            data-testid="remove-skill-file-confirm"
            className="px-3 py-1.5 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {submitting ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
