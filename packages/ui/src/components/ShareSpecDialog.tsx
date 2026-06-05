import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';

interface ShareSpecDialogProps {
  /** The Spec's canonical page URL (std-10) — what gets copied. */
  url: string;
  onClose: () => void;
}

// The header Share dialog: the Spec's canonical URL with a Copy button.
// Replaces the "Coming soon" placeholder. This shares the PAGE LINK (viewers
// need access to the Memex per std-4/std-7) — guest share-link management
// (`/share/:token`) stays in ShareModal behind the ⋯ menu's Share item.
//
// Copy mechanics (clipboard try/catch + transient "Copied" + select-it-yourself
// fallback) follow PromptDialog's idiom.
export function ShareSpecDialog({ url, onClose }: ShareSpecDialogProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

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

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard blocked (NotAllowedError / non-HTTPS): the link is on screen
      // and selectable, so just tell the user to copy manually.
      setCopyFailed(true);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share this spec"
        className="w-[480px] max-w-[92vw] rounded-xl border border-edge bg-panel shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
          <h2 className="text-sm font-semibold text-heading">Share</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-2">
          <p className="text-xs text-secondary">
            Anyone with access to this memex can open the link.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              aria-label="Link to this spec"
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 h-8 px-2.5 rounded-md border border-edge bg-overlay/40 text-sm text-primary font-mono truncate focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <Button size="sm" variant="secondary" className="shrink-0" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {copyFailed && (
            <p role="alert" className="text-xs text-status-danger-text">
              Couldn't write to the clipboard — select the link and copy it manually.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
