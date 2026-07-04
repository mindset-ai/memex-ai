import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';
import { DiffOverlay } from './DiffOverlay';
import type { VersionSummary } from '../api/docs';

// spec-448 t-11 (ac-9, ac-40, ac-41, ac-42): the catch-up-on-reopen dialog.
// Mounted by DocDocument ONLY when the initial GET /docs/:id response says the
// viewer has a doc_views row that's behind the doc's current version
// (`catchUp.hasCatchUp`, computed server-side BEFORE that same call advances
// the marker — see routes/documents.ts spec-448 t-5). The web GET has ALREADY
// advanced the viewer's last-seen to current by the time this renders, so
// "Just open it" is a pure local dismiss — no follow-up API call (ac-42).
// "Show me what changed" swaps this dialog for DiffOverlay, pre-anchored
// fromVersion ⇄ the live primary (ac-42), reusing the same overlay the
// version switcher's compare action opens (t-10) rather than a bespoke view.

interface CatchUpDialogProps {
  docId: string;
  /** The viewer's last-seen version — always < currentVersion when this is mounted. */
  fromVersion: number;
  /** The doc's current (live, uncut) working version. */
  currentVersion: number;
  /** The cut-version history, used only to resolve display names for the two
   *  version labels (falls back to the bare "VN" form when a name isn't
   *  found — e.g. the switcher's own list hasn't loaded yet). */
  versions: VersionSummary[];
  /** Dismiss to the current view — no mutation, the GET already advanced last-seen. */
  onDismiss: () => void;
}

function versionLabel(versionNumber: number, name: string | undefined): string {
  return name ? `V${versionNumber} · ${name}` : `V${versionNumber}`;
}

export function CatchUpDialog({ docId, fromVersion, currentVersion, versions, onDismiss }: CatchUpDialogProps) {
  const [diffOpen, setDiffOpen] = useState(false);

  useEffect(() => {
    if (diffOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss, diffOpen]);

  // "Show me what changed" (ac-42b): swap straight to the anchored diff. The
  // DiffOverlay's own Close returns to the (already-caught-up) current view —
  // this dialog doesn't reappear behind it.
  if (diffOpen) {
    return <DiffOverlay docId={docId} from={fromVersion} to="primary" onClose={onDismiss} />;
  }

  const fromName = versions.find((v) => v.versionNumber === fromVersion)?.name;
  // Mirrors the header version badge's resolution (DocDocument): the live
  // working version has no name of its own until its next cut, so "where the
  // spec is now" borrows the most recent cut's name alongside the current
  // version number.
  const nowName = versions.find((v) => v.versionNumber === currentVersion - 1)?.name;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="catch-up-dialog-title"
      data-testid="catch-up-dialog"
    >
      <div className="w-full max-w-md rounded-xl border border-edge bg-panel shadow-2xl">
        <div className="px-6 py-4 border-b border-edge">
          <h2 id="catch-up-dialog-title" className="text-base font-semibold text-heading">
            This spec has moved on since you last looked
          </h2>
          <p className="mt-1 text-xs text-secondary">
            You last saw <span className="text-primary font-medium">{versionLabel(fromVersion, fromName)}</span> — it&apos;s
            now <span className="text-primary font-medium">{versionLabel(currentVersion, nowName)}</span>.
          </p>
        </div>
        <div className="px-6 py-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onDismiss}
            data-testid="catch-up-just-open"
          >
            Just open it
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setDiffOpen(true)}
            data-testid="catch-up-show-changes"
          >
            Show me what changed
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
