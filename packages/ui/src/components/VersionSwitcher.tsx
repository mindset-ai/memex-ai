import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listVersions,
  getVersionAsOf,
  rollbackVersion,
  type VersionSummary,
  type DocumentVersionRow,
  type SnapshotToken,
} from '../api/docs';
import { MemoizedMarkdown } from './SectionCard';
import { Button } from './ui';
import { formatDate } from '../utils/format';

interface VersionSwitcherProps {
  docId: string;
  /** The doc's current (uncut) working version — the "Current" entry in the
   *  compare pickers and the trailing row below the cut-version list. */
  currentVersion: number;
  /** Called after a restore so the caller can refetch the doc (and this
   *  switcher's own version list follows via its `currentVersion` prop). */
  onRestored: () => void;
  /** Gates the "Restore" affordance — view-as-of and compare stay available
   *  to read-only viewers, but rolling back is a mutation and follows the
   *  same write-gate as the rest of the page's mutating controls. Defaults
   *  to true so callers that don't pass it keep the prior (ungated) shape. */
  canRestore?: boolean;
  /** Called when the user picks a compare pair. The parent renders the diff
   *  inline in the narrative view (spec-448 ac-27) rather than the switcher
   *  popping its own overlay. */
  onCompare?: (from: SnapshotToken, to: SnapshotToken) => void;
  /** Optional override for the trigger button's className so the switcher can
   *  match the surrounding header pills (defaults to a standalone pill). */
  triggerClassName?: string;
}

function parseToken(raw: string): SnapshotToken | null {
  if (!raw) return null;
  if (raw === 'primary') return 'primary';
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// spec-448 t-9 (ac-4, ac-5, ac-6, ac-26): the version-history switcher — a
// small header trigger that opens a panel listing every cut version plus the
// live primary. Per version: "View" (read-only as-of, getVersionAsOf),
// "Restore" (rollbackVersion, auto-freezes the current state first), and a
// compare picker that accepts ANY two entries — including the primary — not
// just adjacent versions (ac-26), which opens DiffOverlay for that pair
// (ac-27). Purely additive: nothing here changes the default page view until
// the user opens it (ac-3).
export function VersionSwitcher({ docId, currentVersion, onRestored, canRestore = true, onCompare, triggerClassName }: VersionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);

  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [viewData, setViewData] = useState<DocumentVersionRow | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);

  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('primary');

  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoadError(null);
    listVersions(docId)
      .then(setVersions)
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Failed to load versions'));
  }, [open, docId, currentVersion]);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    // Keep the 440px panel on-screen. The trigger now lives in the right-hand
    // header cluster, so opening the panel left-aligned to the trigger would
    // run off the right edge — right-align it to the trigger in that case, and
    // clamp to a small margin so it never clips either edge.
    const PANEL_W = 440;
    const MARGIN = 8;
    let left = rect.left;
    if (left + PANEL_W + MARGIN > window.innerWidth) {
      left = rect.right - PANEL_W;
    }
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - PANEL_W - MARGIN));
    setPanelPos({ top: rect.bottom + 4, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleView = (versionNumber: number) => {
    setViewVersion(versionNumber);
    setViewData(null);
    setViewError(null);
    getVersionAsOf(docId, versionNumber)
      .then(setViewData)
      .catch((e) => setViewError(e instanceof Error ? e.message : 'Failed to load version'));
  };

  const handleCompare = () => {
    const from = parseToken(compareFrom);
    const to = parseToken(compareTo);
    if (from === null || to === null) return;
    onCompare?.(from, to);
    setOpen(false);
  };

  const handleRestore = async (versionNumber: number) => {
    setRestoring(true);
    setRestoreError(null);
    try {
      await rollbackVersion(docId, versionNumber);
      setRestoreTarget(null);
      setOpen(false);
      onRestored();
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : 'Failed to restore version');
      setRestoring(false);
    }
  };

  const compareOptions = (
    <>
      <option value="primary">Current</option>
      {versions?.map((v) => (
        <option key={v.versionNumber} value={v.versionNumber}>
          V{v.versionNumber} — {v.name}
        </option>
      ))}
    </>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="version-switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={
          triggerClassName ??
          'inline-flex items-center gap-1 text-xs font-medium text-secondary hover:text-primary px-2 py-1 rounded-md border border-edge hover:bg-overlay transition-colors'
        }
      >
        History
      </button>

      {open &&
        panelPos &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            data-testid="version-switcher-panel"
            style={{ top: panelPos.top, left: panelPos.left }}
            className="fixed z-50 w-[440px] max-h-[70vh] overflow-y-auto rounded-lg border border-edge bg-panel shadow-xl"
          >
            <div className="px-4 py-2 border-b border-edge">
              <h3 className="text-sm font-semibold text-heading">Version history</h3>
            </div>

            <div className="px-4 py-3 border-b border-edge space-y-2">
              <p className="text-xs text-muted">Compare any two versions (including Current):</p>
              <div className="flex items-center gap-2">
                <select
                  aria-label="Compare from"
                  data-testid="compare-from-select"
                  value={compareFrom}
                  onChange={(e) => setCompareFrom(e.target.value)}
                  className="flex-1 min-w-0 text-xs rounded-md border border-edge bg-panel px-2 py-1"
                >
                  <option value="">From…</option>
                  {compareOptions}
                </select>
                <span className="text-xs text-muted flex-none">→</span>
                <select
                  aria-label="Compare to"
                  data-testid="compare-to-select"
                  value={compareTo}
                  onChange={(e) => setCompareTo(e.target.value)}
                  className="flex-1 min-w-0 text-xs rounded-md border border-edge bg-panel px-2 py-1"
                >
                  <option value="">To…</option>
                  {compareOptions}
                </select>
              </div>
              <Button size="sm" onClick={handleCompare} disabled={!compareFrom || !compareTo}>
                Compare
              </Button>
            </div>

            <div className="px-2 py-2">
              {loadError && <p className="px-2 text-xs text-status-danger-text">{loadError}</p>}
              {!versions && !loadError && <p className="px-2 text-xs text-muted">Loading…</p>}
              {versions?.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted">No versions cut yet.</p>
              )}
              {versions?.map((v) => (
                <div
                  key={v.versionNumber}
                  data-testid="version-row"
                  data-version={v.versionNumber}
                  className="px-2 py-2 rounded-md hover:bg-overlay flex items-start justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-primary truncate">
                      V{v.versionNumber} · {v.name}
                    </div>
                    <div className="text-xs text-muted">
                      {v.actorName ?? 'Unknown'} · {formatDate(v.createdAt)}
                      {v.restoredFromVersion != null && ` · restored from V${v.restoredFromVersion}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-none">
                    <button
                      type="button"
                      onClick={() => handleView(v.versionNumber)}
                      className="text-xs text-secondary hover:text-primary px-1.5 py-0.5 rounded-sm hover:bg-overlay"
                    >
                      View
                    </button>
                    {canRestore && (
                      <button
                        type="button"
                        onClick={() => setRestoreTarget(v.versionNumber)}
                        className="text-xs text-secondary hover:text-primary px-1.5 py-0.5 rounded-sm hover:bg-overlay"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <div
                data-testid="version-row-primary"
                className="px-2 py-2 text-xs text-muted border-t border-edge-subtle mt-1"
              >
                V{currentVersion} · Current (working version)
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* View-as-of: a read-only render of the frozen snapshot's sections. */}
      {viewVersion !== null &&
        createPortal(
          <div
            data-testid="version-view-overlay"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
            onClick={(e) => {
              if (e.target === e.currentTarget) setViewVersion(null);
            }}
          >
            <div className="w-[820px] max-w-[95vw] h-[85vh] flex flex-col rounded-xl border border-edge bg-panel shadow-2xl">
              <div className="flex items-center justify-between px-5 py-3 border-b border-edge flex-none">
                <h2 className="text-sm font-semibold text-heading">
                  Viewing V{viewVersion}
                  {viewData ? ` — ${viewData.name}` : ''}
                </h2>
                <button
                  onClick={() => setViewVersion(null)}
                  className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
                  type="button"
                  aria-label="Close version view"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0 space-y-4">
                {viewError && <p className="text-sm text-status-danger-text">{viewError}</p>}
                {!viewData && !viewError && <p className="text-sm text-secondary">Loading…</p>}
                {viewData?.snapshot.sections
                  .slice()
                  .sort((a, b) => a.seq - b.seq)
                  .map((s) => (
                    <div key={s.id} data-testid="version-view-section" className="rounded-lg border border-edge px-4 py-3">
                      {s.title && <h3 className="text-sm font-medium text-heading mb-2">{s.title}</h3>}
                      <MemoizedMarkdown content={s.content} />
                    </div>
                  ))}
              </div>
            </div>
          </div>,
          document.body,
        )}


      {restoreTarget !== null &&
        createPortal(
          <div
            data-testid="restore-confirm"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
            onClick={(e) => {
              if (e.target === e.currentTarget && !restoring) setRestoreTarget(null);
            }}
          >
            <div className="w-[420px] rounded-xl border border-edge bg-panel shadow-2xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-heading">Restore V{restoreTarget}?</h3>
              <p className="text-sm text-secondary">
                This freezes the current working state as a new version first, then restores V{restoreTarget}'s
                content onto the live Spec. The current state is preserved as a version you can restore back to.
              </p>
              {restoreError && <p className="text-sm text-status-danger-text">{restoreError}</p>}
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setRestoreTarget(null)}
                  disabled={restoring}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={() => handleRestore(restoreTarget)} disabled={restoring}>
                  {restoring ? 'Restoring…' : 'Restore'}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
