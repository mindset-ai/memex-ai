import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

// A restrained left-accent per status — the diff reads as the document with
// quiet margin marks, not a boxed report. Unchanged sections carry a
// transparent rail so every section stays optically aligned.
const STATUS_ACCENT: Record<SectionDiffEntry['status'], string> = {
  added: 'border-emerald-400/50',
  removed: 'border-rose-400/50',
  changed: 'border-amber-400/50',
  moved: 'border-edge',
  unchanged: 'border-transparent',
};

const STATUS_MARKER: Record<SectionDiffEntry['status'], string | null> = {
  added: 'new section',
  removed: 'removed',
  changed: 'edited',
  moved: 'moved',
  unchanged: null,
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

  return (
    <div data-testid="diff-overlay">
      {/* A quiet, sticky compare bar — the only chrome; everything below reads
          as the document itself, changes marked in the margin. */}
      <div className="sticky top-0 z-10 mb-8 flex items-center justify-between gap-3 border-b border-edge/60 bg-surface/85 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="truncate text-sm font-medium text-heading">
            {sideLabel(data?.from)} <span className="text-muted">→</span> {sideLabel(data?.to)}
          </span>
          {data && (
            <span className="whitespace-nowrap text-xs text-muted">
              {summary.changed} edited · {summary.added} added · {summary.removed} removed
              {summary.moved ? ` · ${summary.moved} moved` : ''}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          type="button"
          aria-label="Close diff"
          className="flex-none text-xs font-medium text-secondary transition-colors hover:text-primary"
        >
          Exit comparison
        </button>
      </div>

      {error && <p className="text-sm text-status-danger-text">{error}</p>}
      {!data && !error && <p className="text-sm text-muted">Loading comparison…</p>}

      <div className="space-y-10">
        {data &&
          entries.map((entry) => (
            <DiffSection
              key={entry.seq}
              entry={entry}
              setOldRef={setBodyRef(entry.seq, 'oldEl')}
              setNewRef={setBodyRef(entry.seq, 'newEl')}
            />
          ))}
      </div>
    </div>
  );
}

function DiffSection({
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
  const { status } = entry;
  const marker = STATUS_MARKER[status];
  const movedTag = entry.moved && status !== 'moved';

  return (
    <section
      data-testid={status === 'unchanged' ? 'diff-section-unchanged' : 'diff-section'}
      data-status={status}
      className={`border-l-2 pl-5 ${STATUS_ACCENT[status]} ${status === 'removed' ? 'opacity-70' : ''}`}
    >
      <div className="mb-3 flex items-baseline gap-2.5">
        <h2 className="text-xl font-semibold text-heading">{title}</h2>
        {(marker || movedTag) && (
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
            {[marker, movedTag ? 'moved' : null].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>

      {/* Unchanged & moved sections render exactly as the document does — no
          painting — so the comparison reads as the whole doc, not a report. */}
      {(status === 'unchanged' || status === 'moved') && (entry.newSection ?? entry.oldSection) && (
        <MemoizedMarkdown content={(entry.newSection ?? entry.oldSection)!.content} />
      )}

      {/* Added: the new section, insertions painted in place. */}
      {status === 'added' && entry.newSection && (
        <div ref={setNewRef} data-testid="diff-body-new">
          <MemoizedMarkdown content={entry.newSection.content} />
        </div>
      )}

      {/* Removed: the section as it was, deletions painted, dimmed. */}
      {status === 'removed' && entry.oldSection && (
        <div ref={setOldRef} data-testid="diff-body-old">
          <MemoizedMarkdown content={entry.oldSection.content} />
        </div>
      )}

      {/* Changed: the current text in place with insertions painted; the prior
          text follows as a quiet, dimmed reference with deletions painted. */}
      {status === 'changed' && (
        <>
          {entry.newSection && (
            <div ref={setNewRef} data-testid="diff-body-new">
              <MemoizedMarkdown content={entry.newSection.content} />
            </div>
          )}
          {entry.oldSection && (
            <div className="mt-4 border-t border-edge-subtle pt-3">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Previously</p>
              <div ref={setOldRef} data-testid="diff-body-old" className="opacity-60">
                <MemoizedMarkdown content={entry.oldSection.content} />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
