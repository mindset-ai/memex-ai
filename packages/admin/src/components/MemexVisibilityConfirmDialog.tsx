import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';
import type { MemexVisibility } from '../api/client';

// spec-111 t-7: the per-flip confirmation gate. Non-blocking clarity gate, not
// a warning — the action is reversible. Copy is verbatim from spec-111 §2.
//
// `target` is the visibility the user is flipping TO. We render the matching
// body + primary-button label.

const COPY: Record<
  MemexVisibility,
  { heading: string; body: string; confirmLabel: string }
> = {
  public: {
    heading: 'Make this Memex public?',
    body:
      'Anyone with the link will be able to read all specs, decisions, comments, and tasks in this Memex. Org members will retain full edit access. This change takes effect immediately.',
    confirmLabel: 'Make Public',
  },
  private: {
    heading: 'Make this Memex private?',
    body:
      'Public links will stop working immediately. Only org members will be able to view this Memex.',
    confirmLabel: 'Make Private',
  },
};

export function MemexVisibilityConfirmDialog({
  target,
  busy,
  onConfirm,
  onCancel,
}: {
  target: MemexVisibility;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const copy = COPY[target];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={copy.heading}
        className="w-full max-w-md rounded-xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-edge">
          <h2 className="text-base font-semibold text-heading">{copy.heading}</h2>
        </div>
        <div className="p-6">
          <p className="text-sm text-secondary">{copy.body}</p>
        </div>
        <div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? 'Saving…' : copy.confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
