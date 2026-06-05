import { useState, useEffect, useLayoutEffect, useRef, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { DocSection, Comment } from '../api/types';
import { useChat } from './ChatContext';
import { useAuth } from './AuthContext';
import { CommentSourceAvatar } from './CommentSourceAvatar';
import { rehypeRefLinkifier } from './chat/refLinkifier';
import { createComment, resolveComment, deleteComment } from '../api/client';
import { buildCommentLink } from '../utils/commentDeepLink';
import { renderedOffsetToSource, resolveRenderedOffset } from '../utils/anchorOffset';
import { buildAnchorRange } from '../utils/anchorHighlight';
import { SelectionToolbar } from './SelectionToolbar';
import { CommentComposerPopover } from './CommentComposerPopover';

// spec-100: render `[^c-N]` source markers as a visible inline badge so an
// anchored comment shows where it sits in the prose. The marker layer is a
// slave to the gutter filter (scope item 6): a marker shows ONLY when its
// comment is currently visible in the gutter (`visibleSeqs`). Resolved /
// filtered-out comments keep their source marker but don't display it, so the
// text isn't cluttered with markers for comments you can't see. The source
// always keeps the literal marker — resolve is not delete.
export function withRenderedMarkers(content: string, visibleSeqs: ReadonlySet<number>): string {
  // Three source forms: range start `[^c-Ns]`, range end `[^c-Ne]`, legacy point
  // `[^c-N]`. Visible comments render the start as a zero-width anchor sentinel
  // (`📍c-Ns`) and the end/point as the clickable bubble (`📍c-N`); non-visible
  // comments strip all of theirs (resolve hides, not deletes).
  return content.replace(/\[\^c-(\d+)([se]?)\]/g, (_m, n, suffix) => {
    if (!visibleSeqs.has(Number(n))) return '';
    return suffix === 's' ? `\`📍c-${n}s\`` : `\`📍c-${n}\``;
  });
}

interface SectionCardProps {
  section: DocSection;
  sectionNumber: number;
  isNew?: boolean;
  isSelected?: boolean;
  commentCount?: number;
  comments?: Comment[];
  forceShowComments?: boolean;
  onCommentsChange?: (sectionId: string, comments: Comment[]) => void;
  onSelect?: (sectionId: string) => void;
  /** spec-100: when true the comment gutter is hidden — only the inline bubble
   *  markers show. Clicking a marker asks the parent to expand again. */
  commentsCollapsed?: boolean;
  onExpandComments?: () => void;
  /**
   * spec-111 t-8: forwarded to the section's CommentTray — when false (a
   * non-member reading a public Memex) the comment composer + resolve controls
   * are hidden, but the comment list stays readable. Defaults to true.
   */
  canWrite?: boolean;
  /**
   * spec-118 t-6: a reviewer's edit capability. SectionCard renders no inline
   * forward-driving edit controls today (section editing happens through chat,
   * not an in-card button), so this prop currently gates nothing here — it's
   * accepted for symmetry with the other panels and so a future in-card edit
   * affordance has the right gate to hang off. The comment composer stays on
   * `canWrite`, so reviewers keep commenting. Defaults to true.
   */
  canEdit?: boolean;
  /**
   * spec-178 ac-24: when true (a frozen Handhold demo spec) the section body
   * does NOT run rehypeRefLinkifier — `[per dec-N]` / canonical-path handle refs
   * render as plain text instead of becoming navigable `<a>` links. The demo is a
   * self-contained replica of spec-64; its handle refs point at the original spec's
   * world, not the user's, so auto-linking them would send the user down a dead end.
   * Defaults to false (real specs keep auto-linking).
   */
  isDemo?: boolean;
}

export const SectionCard = memo(function SectionCard({
  section,
  sectionNumber,
  isNew,
  isSelected,
  commentCount = 0,
  comments = [],
  onCommentsChange,
  onSelect,
  canWrite = true,
  commentsCollapsed = false,
  isDemo = false,
}: SectionCardProps) {
  const [revealed, setRevealed] = useState(!isNew);

  useEffect(() => {
    if (isNew && !revealed) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setRevealed(true));
      });
    }
  }, [isNew, revealed]);

  const chat = useChat();
  const { user } = useAuth();
  const title = section.title || capitalize(section.sectionType);
  const slug = `section-${sectionNumber}`;

  // spec-100 in-situ creation: select text in the body → anchor a comment to
  // that RANGE. Both selection boundaries are mapped from the rendered DOM to
  // source offsets and bracketed with `[^c-Ns]…[^c-Ne]` sentinels, so the
  // highlight later reproduces exactly what was selected (not a sentence guess).
  const bodyRef = useRef<HTMLDivElement>(null);
  // Google-Docs-style: a text selection surfaces a small floating toolbar (not
  // the composer). The composer only opens when the user clicks "Comment".
  const [toolbar, setToolbar] = useState<{ start: number; end: number; quote: string; top: number; left: number } | null>(null);
  const [anchorDraft, setAnchorDraft] = useState<{ start: number; end: number; quote: string; top: number; left: number } | null>(null);
  const [draftText, setDraftText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSelection = () => {
    if (!canWrite) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { setToolbar(null); return; }
    const text = sel.toString().trim();
    if (!text) { setToolbar(null); return; }
    // Only react to selections inside this section's body.
    if (!bodyRef.current || !sel.anchorNode || !bodyRef.current.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    // Anchor by POSITION, both ends: flatten the body's rendered text (skipping
    // marker badges) into one string while recording each text node's start
    // index, then resolve the selection's start and end boundaries to rendered
    // offsets and map each to the markdown source. Handles inline formatting +
    // repeated words unambiguously, and yields a RANGE, not a point.
    const walker = document.createTreeWalker(bodyRef.current, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest('[data-marker-seq],[data-marker-start]')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    let rendered = '';
    const starts: { node: Node; start: number }[] = [];
    let wn: Node | null;
    while ((wn = walker.nextNode())) {
      starts.push({ node: wn, start: rendered.length });
      rendered += wn.textContent ?? '';
    }
    const renderedStart = resolveRenderedOffset(range.startContainer, range.startOffset, starts, rendered.length);
    const renderedEnd = resolveRenderedOffset(range.endContainer, range.endOffset, starts, rendered.length);
    if (renderedStart < 0 || renderedEnd < 0 || renderedEnd <= renderedStart) return;
    const startSrc = renderedOffsetToSource(section.content, rendered, renderedStart);
    const endSrc = renderedOffsetToSource(section.content, rendered, renderedEnd);
    const rect = range.getBoundingClientRect();
    setToolbar({
      start: startSrc,
      end: endSrc,
      quote: text.slice(0, 60),
      top: rect.top - 40, // float just above the selection
      left: rect.left + rect.width / 2,
    });
  };

  // Dismiss the toolbar on any click that isn't on it (mirrors Docs).
  useEffect(() => {
    if (!toolbar) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.('[data-testid="selection-toolbar"]')) {
        setToolbar(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [toolbar]);

  const openComposerFromToolbar = () => {
    if (!toolbar) return;
    setAnchorDraft({ start: toolbar.start, end: toolbar.end, quote: toolbar.quote, top: toolbar.top, left: toolbar.left });
    setToolbar(null);
  };

  // spec-100 (redesign): comments live as light indicators at the body's right
  // edge, each aligned to its anchored line. Hover an indicator to PEEK the
  // comment; click to PIN it so its actions become reachable. One open at a
  // time. Whatever is open drives the amber span highlight on the passage.
  const cardRef = useRef<HTMLDivElement>(null);
  // Hover (peek) and click (pin) are separate concerns: hover ALWAYS peeks and
  // takes visual precedence; on mouse-leave it falls back to the pinned card. So
  // a pinned card never blocks hovering another comment.
  const [pinnedPop, setPinnedPop] = useState<{ seq: number; top: number; left: number } | null>(null);
  const [hoverPop, setHoverPop] = useState<{ seq: number; top: number; left: number } | null>(null);
  const [markerTops, setMarkerTops] = useState<Record<number, number>>({});
  const shown = hoverPop ?? pinnedPop;
  const shownIsPinned = !!pinnedPop && shown?.seq === pinnedPop.seq;
  // Stable value-key of the open comments (their seqs), so the marker-measuring
  // effect below depends on WHAT'S open, not on the `comments` array identity —
  // the `comments = []` default is a fresh array each render and would otherwise
  // re-fire the effect → setMarkerTops → re-render → infinite loop.
  const openSeqKey = comments.filter((c) => !c.resolvedAt).map((c) => c.seq).join(',');

  // Amber highlight of the anchored span, computed from the marker positions in
  // the rendered DOM (immune to inline markdown): the span between a comment's
  // start sentinel and end marker, or the marker's sentence for a point anchor.
  const highlightAnchored = (seq: number) => {
    const cssAny = CSS as unknown as { highlights?: Map<string, unknown> };
    if (!cssAny.highlights || typeof Highlight === 'undefined') return;
    cssAny.highlights.delete('geo-anchor');
    const endEl = document.getElementById(`marker-c-${seq}`);
    if (!endEl) return;
    const startEl = document.getElementById(`marker-c-${seq}-start`);
    const range = buildAnchorRange(endEl, startEl);
    if (range) cssAny.highlights.set('geo-anchor', new Highlight(range));
  };

  // The highlight follows whatever popover is open (peek or pinned) and clears
  // when none is.
  useEffect(() => {
    const cssAny = CSS as unknown as { highlights?: Map<string, unknown> };
    if (!shown) { cssAny.highlights?.delete('geo-anchor'); return; }
    highlightAnchored(shown.seq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  // Open the card to the RIGHT of the indicator (into the margin) so it never
  // covers the commented passage, clamped so it can't run off-screen.
  const POPOVER_W = 300;
  const popoverPosFor = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const left = Math.min(r.right + 10, window.innerWidth - POPOVER_W - 8);
    return { top: r.top, left };
  };
  // Hover peeks (always); leaving clears the peek (falls back to any pinned card).
  const peekComment = (seq: number, el: HTMLElement) =>
    setHoverPop({ seq, ...popoverPosFor(el) });
  const unpeek = () => setHoverPop(null);
  // Click pins the card (stable surface for resolve/delete/copy-link).
  const pinComment = (seq: number, el: HTMLElement) => {
    setPinnedPop({ seq, ...popoverPosFor(el) });
    setHoverPop(null);
  };

  // Measure each open comment's marker top (relative to the card) so its edge
  // indicator sits beside the anchored line. Re-measure on content/size change.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const measure = () => {
      const cardTop = card.getBoundingClientRect().top;
      const next: Record<number, number> = {};
      for (const c of openComments) {
        if (c.seq == null) continue;
        const el = document.getElementById(`marker-c-${c.seq}`);
        if (el) next[c.seq] = el.getBoundingClientRect().top - cardTop;
      }
      setMarkerTops(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(card);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSeqKey, section.content, commentsCollapsed]);

  // Clear the highlight when this section unmounts.
  useEffect(() => () => {
    (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete('geo-anchor');
  }, []);

  // Collapsing comments doc-wide closes any open popover (and its highlight).
  useEffect(() => {
    if (commentsCollapsed) { setPinnedPop(null); setHoverPop(null); }
  }, [commentsCollapsed]);

  // A click anywhere outside a PINNED popover closes it. The popover itself is
  // interactive, so clicks inside it are ignored. An indicator click is ignored
  // ONLY when it belongs to THIS section (its own onClick moves the pin);
  // clicking an indicator in a DIFFERENT section must close this one, so the doc
  // never shows two pinned cards at once. Peeks close on mouse-leave.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[data-testid="comment-popover"]')) return;
      const indicator = t?.closest?.('[data-indicator-seq]');
      if (indicator && cardRef.current?.contains(indicator)) return;
      setPinnedPop(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Open comments for this section, anchored ones first (they own a marker).
  const openComments = comments
    .filter((c) => !c.resolvedAt)
    .sort((a, b) => Number(b.anchorSnippet != null) - Number(a.anchorSnippet != null));

  // Markers in the body mirror the gutter: only comments currently shown (open)
  // display their `[^c-N]` marker. Resolving a comment hides its marker (the
  // card is gone); it isn't deleted, so it returns under a resolved/all view.
  const visibleSeqs = new Set(
    openComments.map((c) => c.seq).filter((s): s is number => s != null),
  );

  // spec-100 card actions: mark done (resolve) and delete-your-own. Both drop
  // the card from the open list on success.
  const dropCard = (id: string) => onCommentsChange?.(section.id, comments.filter((x) => x.id !== id));
  const resolveCard = async (c: Comment) => { await resolveComment(c.id); dropCard(c.id); };
  const deleteCard = async (c: Comment) => { await deleteComment(c.id); dropCard(c.id); };
  // spec-100: delete is permanent, so require explicit confirmation on the card
  // before it's gone forever.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // spec-100 ac-6: copy a stable deep-link to this comment from its gutter card
  // (same affordance the Comments tab exposes). Momentary "Copied" feedback.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyCardLink = (c: Comment) => {
    if (c.seq == null) return;
    void navigator.clipboard?.writeText(buildCommentLink(window.location.href, c.seq));
    setCopiedId(c.id);
    setTimeout(() => setCopiedId((cur) => (cur === c.id ? null : cur)), 1500);
  };

  // spec-100: curb sprawl — a long comment is clamped until "Show more".
  const COMMENT_PREVIEW = 180;
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) =>
    setExpandedCards((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const [saveError, setSaveError] = useState<string | null>(null);
  const submitAnchored = async () => {
    if (!anchorDraft || !draftText.trim()) return;
    setSubmitting(true);
    setSaveError(null);
    // Don't let a wedged request spin "Saving…" forever — time out and let the
    // user retry (the draft is preserved on failure).
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 12000),
    );
    try {
      const created = (await Promise.race([
        createComment(section.id, user?.name ?? 'You', draftText.trim(), { type: 'issue' }, anchorDraft.end, anchorDraft.start),
        timeout,
      ])) as Awaited<ReturnType<typeof createComment>>;
      onCommentsChange?.(section.id, [...comments, created]);
      setAnchorDraft(null);
      setDraftText('');
    } catch {
      setSaveError("Couldn't save — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      id={slug}
      data-testid="section-card"
      data-section-id={section.id}
      className={`relative scroll-mt-4 transition-all duration-500 ease-out ${
        isNew && !revealed
          ? 'max-h-0 opacity-0 overflow-hidden'
          : 'max-h-none opacity-100'
      }`}
    >
      <div
        onClick={() => {
          onSelect?.(section.id);
          chat.addContextChip({
            type: 'section',
            id: section.id,
            label: `Section ${sectionNumber} — ${title}`,
          });
        }}
        className={`
          group relative rounded-lg px-5 py-4 cursor-pointer
          border transition-all duration-200
          bg-page
          ${isSelected
            ? 'border-edge-strong bg-selected shadow-lg'
            : 'border-transparent hover:border-edge hover:bg-card-hover'
          }
        `}
      >
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-edge">
          <h2 className="text-xl font-semibold flex-1 text-heading">
            <span className="text-muted mr-3 font-normal tabular-nums">{sectionNumber}</span>
            {title}
          </h2>
          <button
            onClick={(e) => {
              e.stopPropagation();
              chat.addContextChip({
                type: 'section',
                id: section.id,
                label: `Section ${sectionNumber} — ${title}`,
              });
            }}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-card-hover"
            title="Focus chat on this section"
          >
            <svg className="w-3.5 h-3.5 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
            </svg>
          </button>
          {commentCount > 0 && (
            <span data-testid="section-comment-count" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-secondary bg-surface/50 border border-edge">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
              {commentCount}
            </span>
          )}
        </div>

        {/* spec-100 (redesign): full-width body. Comments are light indicators
            at the right edge (no reserved gutter); hover peeks, click pins. */}
        <div ref={cardRef} className="relative">
          <div
            ref={bodyRef}
            onMouseUp={handleSelection}
            data-testid="section-body"
            className="min-w-0 pr-8"
          >
            <MemoizedMarkdown content={withRenderedMarkers(section.content, visibleSeqs)} isDemo={isDemo} />
          </div>

          {/* right-edge comment indicators, one per open comment, vertically
              aligned to its anchored line (measured). Generic comment icon for
              now; per-author avatars later. */}
          {!commentsCollapsed && openComments.map((c) =>
            c.seq != null && markerTops[c.seq] != null ? (
              <button
                key={c.id}
                id={`indicator-c-${c.seq}`}
                data-indicator-seq={c.seq}
                type="button"
                style={{ top: markerTops[c.seq] }}
                onMouseEnter={(e) => peekComment(c.seq!, e.currentTarget)}
                onMouseLeave={unpeek}
                onClick={(e) => { e.stopPropagation(); pinComment(c.seq!, e.currentTarget); }}
                aria-label="View comment"
                title="View comment"
                className={`absolute right-0 -translate-y-0.5 inline-flex items-center justify-center w-7 h-7 rounded-full border shadow-sm transition-colors ${
                  shown?.seq === c.seq
                    ? 'bg-accent text-white border-accent'
                    : 'bg-surface text-secondary border-edge-subtle hover:text-accent hover:border-edge-strong'
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                </svg>
              </button>
            ) : null,
          )}
        </div>

        {/* peek (hover) / pinned (click) comment popover. Actions only show
            when pinned, so a peek stays read-only. */}
        {shown && (() => {
          const c = openComments.find((x) => x.seq === shown.seq);
          if (!c) return null;
          const long = c.content.length > COMMENT_PREVIEW;
          const expanded = expandedCards.has(c.id);
          const bodyText = long && !expanded ? `${c.content.slice(0, COMMENT_PREVIEW).trimEnd()}…` : c.content;
          return (
            <div
              data-testid="comment-popover"
              data-pinned={shownIsPinned}
              onClick={(e) => e.stopPropagation()}
              style={{ position: 'fixed', top: shown.top - 8, left: shown.left, zIndex: 50, width: POPOVER_W }}
              className="rounded-xl border border-edge-subtle bg-surface shadow-lg p-3 space-y-1"
            >
              <div className="flex items-center gap-2">
                <CommentSourceAvatar source={c.source} authorName={c.authorName} />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-primary truncate">{c.authorName}</div>
                  {c.createdAt && <div className="text-[10px] text-muted">{formatCommentTime(c.createdAt)}</div>}
                </div>
              </div>
              <p className="text-sm text-secondary whitespace-pre-wrap break-words">{bodyText}</p>
              {long && (
                <button type="button" data-testid={`card-showmore-${c.seq}`} onClick={(e) => { e.stopPropagation(); toggleExpand(c.id); }} className="text-[11px] text-accent hover:underline">
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
              {shownIsPinned && canWrite && (
                <div className="flex items-center gap-3 pt-2 mt-1 border-t border-edge-subtle">
                  <button type="button" data-testid={`card-resolve-${c.seq}`} onClick={(e) => { e.stopPropagation(); void resolveCard(c); setPinnedPop(null); setHoverPop(null); }} className="text-[11px] text-secondary hover:text-status-success-text">✓ Done</button>
                  {c.seq != null && (
                    <button type="button" data-testid={`card-copy-link-${c.seq}`} aria-label="Copy link to this comment" title="Copy link to this comment" onClick={(e) => { e.stopPropagation(); copyCardLink(c); }} className="inline-flex items-center gap-1 text-[11px] text-secondary hover:text-accent">
                      {copiedId === c.id ? 'Copied' : (
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>
                      )}
                    </button>
                  )}
                  {c.authorUserId && c.authorUserId === user?.id && (
                    confirmDeleteId === c.id ? (
                      <span className="ml-auto inline-flex items-center gap-2">
                        <span className="text-[11px] text-muted">Delete forever?</span>
                        <button type="button" data-testid={`card-delete-confirm-${c.seq}`} onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); void deleteCard(c); setPinnedPop(null); setHoverPop(null); }} className="text-[11px] font-medium text-status-danger-text hover:underline">Delete</button>
                        <button type="button" data-testid={`card-delete-cancel-${c.seq}`} onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }} className="text-[11px] text-secondary hover:text-primary">Cancel</button>
                      </span>
                    ) : (
                      <button type="button" data-testid={`card-delete-${c.seq}`} onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(c.id); }} className="text-[11px] text-secondary hover:text-status-danger-text ml-auto">Delete</button>
                    )
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* spec-100: selection toolbar (icon pill) → composer popover, both
            anchored at the selection. */}
        {toolbar && (
          <SelectionToolbar top={toolbar.top} left={toolbar.left} onComment={openComposerFromToolbar} />
        )}
        {anchorDraft && (
          <CommentComposerPopover
            top={anchorDraft.top}
            left={anchorDraft.left}
            value={draftText}
            submitting={submitting}
            error={saveError}
            onChange={setDraftText}
            onSubmit={submitAnchored}
            onCancel={() => { setAnchorDraft(null); setDraftText(''); setSaveError(null); }}
          />
        )}

      </div>
    </div>
  );
});

const remarkPlugins = [remarkGfm];
// spec-178 ac-24: the demo variant drops rehypeRefLinkifier so handle refs in a
// frozen demo spec render as plain text (no auto-linking). Pre-built once per
// variant so the markdown renderer still gets a stable array reference.
const rehypePluginsDefault = [rehypeHighlight, rehypeRefLinkifier];
const rehypePluginsDemo = [rehypeHighlight];

// spec-100: a `📍c-N` inline-code span (produced by withRenderedMarkers) renders
// as an interactive marker badge — clickable + locatable from the gutter via its
// `marker-c-N` id and `data-marker-seq`. Anything else stays normal code.
const markdownComponents = {
  code({ className, children, ...props }: { className?: string; children?: React.ReactNode }) {
    const text = Array.isArray(children) ? children.join('') : String(children ?? '');
    // Range START sentinel: a zero-width anchor the highlight uses as the left
    // edge of the amber span. It has no glyph and isn't clickable; it only marks
    // a DOM position via `marker-c-N-start`.
    const start = /^📍c-(\d+)s$/.exec(text);
    if (start) {
      return (
        <span
          id={`marker-c-${start[1]}-start`}
          data-marker-start={start[1]}
          aria-hidden="true"
          style={{ fontSize: 0, width: 0, display: 'inline' }}
        />
      );
    }
    const m = /^📍c-(\d+)$/.exec(text);
    if (m) {
      // spec-100 (redesign): the END marker is now a zero-width DOM anchor only.
      // The visible affordance moved to the right-edge indicator; this element
      // exists so the amber highlight + the indicator's vertical position can be
      // computed from its place in the rendered prose.
      return (
        <span
          id={`marker-c-${m[1]}`}
          data-marker-seq={m[1]}
          aria-hidden="true"
          style={{ fontSize: 0, width: 0, display: 'inline' }}
        />
      );
    }
    return <code className={className} {...props}>{children}</code>;
  },
};

const MemoizedMarkdown = memo(function MemoizedMarkdown({
  content,
  isDemo = false,
}: {
  content: string;
  isDemo?: boolean;
}) {
  const rehypePlugins = isDemo ? rehypePluginsDemo : rehypePluginsDefault;
  return (
    <div className="prose-dark overflow-hidden">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

// Short comment timestamp: "14:57 Today" for today, else "12 May 14:57".
function formatCommentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${time} Today`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

function capitalize(s: string): string {
  return s
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
