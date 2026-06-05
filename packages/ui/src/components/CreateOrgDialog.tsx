import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from './AuthContext';
import { CreateOrgForm } from './CreateOrgForm';

// Modal wrapper around CreateOrgForm, opened from the MemexSwitcher dropdown.
// Portals into document.body so the fixed-positioned overlay isn't trapped by ancestor
// transforms/contain rules (react-resizable-panels establishes such a containing block).
// Gates on email verification — unverified users see an explanation instead of the form
// since the server rejects POST /api/orgs with 403 in that case anyway.
export function CreateOrgDialog({ onClose }: { onClose: () => void }) {
  const { session } = useAuth();

  // ESC closes — dialog convention.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const emailVerified = session?.user.emailVerified ?? false;

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
          <h2 className="text-base font-semibold text-heading">Create a new Org</h2>
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
          {emailVerified ? (
            <CreateOrgForm onCancel={onClose} />
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-secondary">
                Verify your email address before creating a new Org. Org Memexes let
                other people collaborate with you, so we confirm your identity first. You
                can keep using your Personal Memex in the meantime.
              </p>
              <p className="text-xs text-muted">
                Check your inbox for the verification link we sent when you signed up.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
