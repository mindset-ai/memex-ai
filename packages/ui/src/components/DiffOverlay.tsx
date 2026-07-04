import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getVersionDiffData, type SnapshotToken, type VersionDiffData, type VersionOrPrimarySnapshot } from '../api/docs';
import { alignSections, summarizeSectionDiff, type SectionDiffEntry } from '../utils/diffSections';
import { computeDiffRanges, registerDiffHighlights, clearDiffHighlights, type DiffRanges } from '../utils/diffHighlight';
import { MemoizedMarkdown } from './SectionCard';

// spec-448 t-10 (ac-27): the version switcher's "compare" action renders the
// diff INLINE as an overlay on the narrative view — no separate route/page.
// It reuses SectionCard's own markdown renderer (`MemoizedMarkdown`) for
// every section body, so a diffed section looks like the same doc, just with
// changed words/paragraphs painted on top via the CSS Custom Highlight API
// (ac-31) — never a bespoke diff-viewer component (ac-29).

interface DiffOverlayProps {
  docId: string;
  from: SnapshotToken;
  to: SnapshotToken;
  onClose: () => void;
}

function sideLabel(side: VersionOrPrimarySnapshot | undefined): string {
  if (!side) return '…';
  if (side.version === 'primary') return 'Current';
  return side.name ? `v${side.version} — ${side.name}` : `v${side.version}`;
}

const STATUS_BADGE: Record<SectionDiffEntry['status'], string> = {
  added: 'bg-status-success-bg text-status-success-text border-status-success-border',
  removed: 'bg-status-danger-bg text-status-danger-text border-status-danger-border',
  changed: 'bg-status-info-bg text-status-info-text border-status-info-border',
  moved: 'bg-status-neutral-bg text-status-neutral-text border-status-neutral-border',
  unchanged: 'bg-status-neutral-bg text-status-neutral-text border-status-neutral-border',
};

const STATUS_LABEL: Record<SectionDiffEntry['status'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  moved: 'Moved',
  unchanged: 'Unchanged',
};

export function DiffOverlay({ docId, from, to, onClose }: DiffOverlayProps) {
  const [data, setData] = useState<VersionDiffData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getVersionDiffData(docId, from, to)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load diff');
      });
    return () => {
      cancelled = true;
    };
  }, [docId, from, to]);

  const entries = useMemo(() => {
    if (!data) return [];
    return alignSections(data.from.snapshot.sections, data.to.snapshot.sections);
  }, [data]);

  const summary = useMemo(() => summarizeSectionDiff(entries), [entries]);

  // Each diffable entry (added/removed/changed) registers its rendered old
  // and/or new body element here; once every section for this comparison has
  // painted, ONE effect below merges every entry's Ranges into the three
  // named Custom Highlights (diff-add/diff-del/diff-block) — the registry is
  // process-wide, so per-entry registration would just clobber the last one.
  const bodyRefs = useRef(new Map<number, { oldEl: HTMLDivElement | null; newEl: HTMLDivElement | null }>());
  const setBodyRef = (seq: number, side: 'oldEl' | 'newEl') => (el: HTMLDivElement | null) => {
    const current = bodyRefs.current.get(seq) ?? { oldEl: null, newEl: null };
    bodyRefs.current.set(seq, { ...current, [side]: el });
  };

  useLayoutEffect(() => {
    if (entries.length === 0) return;
    const merged: DiffRanges = { oldBlockRanges: [], newBlockRanges: [], delRanges: [], addRanges: [] };
    for (const entry of entries) {
      if (entry.status !== 'added' && entry.status !== 'removed' && entry.status !== 'changed') continue;
      const refs = bodyRefs.current.get(entry.seq);
      // A missing side (added has no old body, removed has no new body) diffs
      // against an empty detached container — computeDiffRanges then treats
      // every block on the present side as a pure addition/removal, so no
      // special-casing is needed beyond supplying an empty stand-in.
      const oldEl = refs?.oldEl ?? document.createElement('div');
      const newEl = refs?.newEl ?? document.createElement('div');
      const ranges = computeDiffRanges(oldEl, newEl);
      merged.oldBlockRanges.push(...ranges.oldBlockRanges);
      merged.newBlockRanges.push(...ranges.newBlockRanges);
      merged.delRanges.push(...ranges.delRanges);
      merged.addRanges.push(...ranges.addRanges);
    }
    registerDiffHighlights(merged);
    return () => clearDiffHighlights();
  }, [entries]);

  return createPortal(
    <div
      data-testid="diff-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[820px] max-w-[95vw] h-[85vh] flex flex-col rounded-xl border border-edge bg-panel shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge flex-none">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-heading truncate">
              Comparing {sideLabel(data?.from)} → {sideLabel(data?.to)}
            </h2>
            {data && (
              <p className="text-xs text-muted mt-0.5">
                {summary.changed} changed · {summary.added} added · {summary.removed} removed · {summary.moved} moved
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors flex-none"
            type="button"
            aria-label="Close diff"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0 space-y-4">
          {error && <p className="text-sm text-status-danger-text">{error}</p>}
          {!data && !error && <p className="text-sm text-secondary">Loading diff…</p>}
          {data &&
            entries.map((entry) => (
              <DiffSectionRow
                key={entry.seq}
                entry={entry}
                setOldRef={setBodyRef(entry.seq, 'oldEl')}
                setNewRef={setBodyRef(entry.seq, 'newEl')}
              />
            ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DiffSectionRow({
  entry,
  setOldRef,
  setNewRef,
}: {
  entry: SectionDiffEntry;
  setOldRef: (el: HTMLDivElement | null) => void;
  setNewRef: (el: HTMLDivElement | null) => void;
}) {
  const title =
    entry.newSection?.title ?? entry.oldSection?.title ?? entry.newSection?.sectionType ?? entry.oldSection?.sectionType ?? 'Section';

  // Unchanged sections add no signal to a diff view — collapse to a thin
  // divider so the overlay reads as "what changed", not the whole doc again.
  if (entry.status === 'unchanged') {
    return (
      <div data-testid="diff-section-unchanged" className="text-xs text-muted py-1 border-b border-edge-subtle">
        {title} — unchanged
      </div>
    );
  }

  return (
    <div data-testid="diff-section" data-status={entry.status} className="rounded-lg border border-edge px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-sm border ${STATUS_BADGE[entry.status]}`}>
          {STATUS_LABEL[entry.status]}
        </span>
        {entry.moved && entry.status !== 'moved' && (
          <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-sm border bg-status-neutral-bg text-status-neutral-text border-status-neutral-border">
            Moved
          </span>
        )}
        <h3 className="text-sm font-medium text-heading truncate">{title}</h3>
      </div>

      {entry.status === 'moved' && entry.newSection && (
        <div className="min-w-0">
          <MemoizedMarkdown content={entry.newSection.content} />
        </div>
      )}

      {entry.status === 'removed' && entry.oldSection && (
        <div ref={setOldRef} data-testid="diff-body-old" className="min-w-0">
          <MemoizedMarkdown content={entry.oldSection.content} />
        </div>
      )}

      {entry.status === 'added' && entry.newSection && (
        <div ref={setNewRef} data-testid="diff-body-new" className="min-w-0">
          <MemoizedMarkdown content={entry.newSection.content} />
        </div>
      )}

      {entry.status === 'changed' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {entry.oldSection && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Before</p>
              <div ref={setOldRef} data-testid="diff-body-old" className="min-w-0">
                <MemoizedMarkdown content={entry.oldSection.content} />
              </div>
            </div>
          )}
          {entry.newSection && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted mb-1">After</p>
              <div ref={setNewRef} data-testid="diff-body-new" className="min-w-0">
                <MemoizedMarkdown content={entry.newSection.content} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
