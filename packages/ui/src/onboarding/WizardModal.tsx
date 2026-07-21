// spec-502: the onboarding wizard, presented as a large closeable modal.
//
// The Explore companion's "Create your own Memex" CTA opens this instead of
// navigating to a full-page /wizard route — so the user keeps their place on the
// live Memex behind it and can back out (Esc, backdrop click, or the ✕) without a
// route change. It takes over most of the screen. Same <Wizard/> body; the shell
// only adds the overlay + dismissal affordances (mirrors ExecutionPlanModal).
//
// Dismissal is Esc / backdrop / ✕. A completed wizard navigates the user into
// their own Memex, which unmounts this overlay on its own — no explicit close.

import { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Wizard } from './Wizard';

export function WizardModal({ onClose }: { onClose: () => void }) {
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return createPortal(
    <div
      data-testid="wizard-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Create your own Memex"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 sm:p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-[min(1100px,94vw)] h-[min(90vh,920px)] flex flex-col rounded-2xl border border-edge bg-panel shadow-2xl overflow-hidden">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          data-testid="wizard-modal-close"
          className="absolute top-4 right-4 z-10 p-1.5 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Scrollable body — the Wizard centres its own narrow column within. */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <Wizard />
        </div>
      </div>
    </div>,
    document.body,
  );
}
