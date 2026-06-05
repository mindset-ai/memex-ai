import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AddMemexForm } from './AddMemexForm';

// Modal wrapper around AddMemexForm. Mirrors CreateOrgDialog's portal + ESC +
// click-outside behaviour so the modal isn't trapped by ancestor containing
// blocks (react-resizable-panels establishes them).
//
// Opened from two surfaces per dec-5 of doc-19: the Org-page primary CTA and
// the MemexSwitcher dropdown sub-row.
export function AddMemexDialog({
  namespaceId,
  namespaceSlug,
  orgName,
  onClose,
  onCreated,
}: {
  namespaceId: string;
  namespaceSlug: string;
  orgName: string;
  onClose: () => void;
  // Override the post-create behavior. When omitted, AddMemexForm falls back
  // to a full-page redirect into the new Memex (legacy behavior for the
  // MemexSwitcher path). The Manage Orgs page passes `onClose` here so the
  // dialog closes and the caller can refresh the list in place.
  onCreated?: (memexSlug: string) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-edge flex items-center justify-between">
          <h2 className="text-base font-semibold text-heading">
            Add a Memex to {orgName}
          </h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-primary transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-6">
          <AddMemexForm
            namespaceId={namespaceId}
            namespaceSlug={namespaceSlug}
            orgName={orgName}
            onCancel={onClose}
            onCreated={onCreated}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
