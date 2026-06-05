import { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';

interface ComingSoonDialogProps {
  title: string;
  onClose: () => void;
}

export function ComingSoonDialog({ title, onClose }: ComingSoonDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[420px] rounded-xl border border-edge bg-panel shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
          <h2 className="text-sm font-semibold text-heading">{title}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-6">
          <p className="text-sm text-secondary">Coming soon.</p>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-edge">
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
