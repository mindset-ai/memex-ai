import type { Comment, Doc, DocSection } from '../api/types';

interface DocOutlineProps {
  doc: Doc;
  sections: DocSection[];
  activeSectionId?: string | null;
  /** Per-section UNRESOLVED comment count — the badge stays a "needs attention"
   *  signal (spec-361 dec-1), independent of how many children render. */
  commentCounts?: Record<string, number>;
  /** Full comment thread per section. Rendered as always-expanded child rows
   *  beneath each segment (spec-361). Comments only — decisions/tasks are not
   *  projected into the outline. */
  commentsBySection?: Record<string, Comment[]>;
  onSectionClick?: (sectionId: string) => void;
  /** Click a comment child → navigate to it in situ (spec-325 deep-link path). */
  onCommentClick?: (seq: number, sectionId: string) => void;
}

export function DocOutline({
  doc: _doc,
  sections,
  activeSectionId,
  commentCounts = {},
  commentsBySection = {},
  onSectionClick,
  onCommentClick,
}: DocOutlineProps) {
  if (sections.length === 0) return null;

  return (
    <div className="text-xs">
      <div className="uppercase tracking-wider text-muted/70 mb-2 px-2">Segments</div>
      <nav className="border-l border-edge-subtle">
        {sections.map((section, index) => {
          const num = index + 1;
          const title = section.title || capitalize(section.sectionType);
          const isActive = section.id === activeSectionId;
          const comments = commentCounts[section.id] ?? 0;
          // spec-361: the section's comments, oldest first, rendered as children.
          const childComments = [...(commentsBySection[section.id] ?? [])].sort(
            (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
          );

          return (
            <div key={section.id}>
              <a
                href={`#section-${num}`}
                // spec-361 (issue-2): scroll-spy marks the in-view segment active.
                aria-current={isActive ? 'true' : undefined}
                onClick={(e) => {
                  if (onSectionClick) {
                    e.preventDefault();
                    onSectionClick(section.id);
                    document
                      .getElementById(`section-${num}`)
                      ?.scrollIntoView({ behavior: 'smooth' });
                  }
                }}
                className={`
                  flex items-center gap-2 pl-3 pr-2 py-1 -ml-px border-l transition-colors no-underline
                  ${isActive
                    ? 'text-primary! font-medium border-primary'
                    : 'text-muted! hover:text-secondary! border-transparent'
                  }
                `}
              >
                <span className="flex-none w-3 text-right font-mono opacity-50">{num}</span>
                <span className="truncate flex-1">{title}</span>
                {/* spec-361 dec-1: badge = UNRESOLVED count, hidden at zero. */}
                {comments > 0 && (
                  <span className="flex-none text-muted">{comments}</span>
                )}
              </a>

              {/* spec-361: always-expanded comment children. No empty container
                  when a segment has no comments. */}
              {childComments.length > 0 && (
                <div className="border-l border-edge-subtle">
                  {childComments.map((c) => {
                    const resolved = c.resolvedAt != null;
                    const isAgent = c.source === 'agent';
                    const canNavigate = c.seq != null && onCommentClick != null;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        disabled={!canNavigate}
                        data-comment-seq={c.seq ?? ''}
                        data-source={c.source ?? 'human'}
                        data-resolved={resolved ? 'true' : 'false'}
                        aria-label={`Comment by ${c.authorName}: ${c.content}`}
                        title={`${c.authorName}: ${c.content}`}
                        onClick={() => {
                          if (c.seq != null) onCommentClick?.(c.seq, section.id);
                        }}
                        className={`
                          group flex w-full items-start gap-1.5 pl-6 pr-2 py-1 -ml-px border-l border-transparent
                          text-left transition-colors no-underline text-muted! hover:text-secondary!
                          ${canNavigate ? 'cursor-pointer' : 'cursor-default'}
                        `}
                      >
                        <span aria-hidden className="flex-none leading-tight">💬</span>
                        <span className="min-w-0 flex-1">
                          {/* spec-361 dec-2 / ac-8: resolved → strikethrough. */}
                          <span
                            className={`block truncate ${resolved ? 'line-through opacity-60' : ''}`}
                          >
                            {c.content}
                          </span>
                          {/* author + human-vs-agent indicator (dec-2 / ac-7). */}
                          <span className="block truncate text-[10px] text-muted/70">
                            {c.authorName}
                            {isAgent && (
                              <span className="ml-1 rounded-sm bg-edge-subtle px-1 font-mono uppercase">
                                AI
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function capitalize(s: string): string {
  return s
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
