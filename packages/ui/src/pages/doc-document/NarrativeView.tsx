import type { Comment, DocSection, DocWithGraph } from '../../api/types';
import { SectionCard } from '../../components/SectionCard';
import { DocOutline } from '../../components/DocOutline';

// spec-362 (dec-1, sol-3 + perf-6): the Specify "Narrative" sub-tab view,
// extracted verbatim out of DocDocument's body. It renders the narrative
// section list (qa_report sections already excluded by the caller) plus the
// sticky outline aside.
//
// perf-6 (virtualization): each section is wrapped in a `content-visibility:
// auto` container with a `contain-intrinsic-size` placeholder. The browser
// skips layout & paint of off-screen sections (the eager-render cost perf-6
// targets) WITHOUT unmounting them — so the cross-list DOM coupling that
// SectionCard and DocDocument rely on keeps working unchanged:
//   • handleSelectSection scrolls via document.getElementById(`section-N`),
//   • SectionCard measures every open comment's marker via getElementById,
//   • the spec-325 comment deep-link pins a card in whichever section owns it,
//   • the amber `geo-anchor` Highlight is built from marker DOM ranges.
// All four require the nodes to stay in the DOM; content-visibility keeps them
// there. The `contain-intrinsic-size` is a height *estimate* used only while a
// section is skipped; it does not clip or change rendered content.

// A generous per-section intrinsic-size estimate (used only as the placeholder
// height for skipped, off-screen sections). Conservatively tall so the
// scrollbar doesn't visibly jump as sections paint in.
const SECTION_INTRINSIC_SIZE = '480px';

interface NarrativeViewProps {
  doc: DocWithGraph;
  /** qa_report sections already filtered out by the caller (spec-260 ac-12). */
  narrativeSections: DocSection[];
  selectedSectionId: string | null;
  totalCommentCount: number;
  commentCounts: Record<string, number>;
  commentsBySection: Record<string, Comment[]>;
  commentsCollapsed: boolean;
  canWrite: boolean;
  canEdit: boolean;
  onToggleCommentsCollapsed: () => void;
  onExpandComments: () => void;
  onSectionCommentsChange: (sectionId: string, comments: Comment[]) => void;
  onSelectSection: (sectionId: string) => void;
  /** spec-325 (dec-1): the comment deep-link's seq, handed to every section. */
  deepLinkCommentSeq: number | null;
  /** Outline aside click → DocDocument's handleSelectSection. */
  onOutlineSectionClick: (sectionId: string) => void;
}

export function NarrativeView({
  doc,
  narrativeSections,
  selectedSectionId,
  totalCommentCount,
  commentCounts,
  commentsBySection,
  commentsCollapsed,
  canWrite,
  canEdit,
  onToggleCommentsCollapsed,
  onExpandComments,
  onSectionCommentsChange,
  onSelectSection,
  deepLinkCommentSeq,
  onOutlineSectionClick,
}: NarrativeViewProps) {
  return (
    <div className="flex gap-8 items-start">
      <div className="flex-1 space-y-3 min-w-0">
        {totalCommentCount > 0 && (
          <div className="flex justify-end">
            <button
              type="button"
              data-testid="toggle-comment-gutter"
              onClick={onToggleCommentsCollapsed}
              className="text-xs text-secondary hover:text-primary inline-flex items-center gap-1 px-2 py-1 rounded-md border border-edge hover:bg-overlay"
            >
              {commentsCollapsed ? 'Show comments' : 'Hide comments'}
            </button>
          </div>
        )}
        {/* spec-260 ac-12: qa_report sections are excluded — build output, not plan prose. */}
        {narrativeSections.map((section, index) => (
          // perf-6: content-visibility:auto skips off-screen layout/paint while
          // keeping the SectionCard mounted (DOM coupling preserved).
          <div
            key={section.id}
            data-testid="section-vwrap"
            style={{
              contentVisibility: 'auto',
              containIntrinsicSize: `auto ${SECTION_INTRINSIC_SIZE}`,
            }}
          >
            <SectionCard
              section={section}
              sectionNumber={index + 1}
              isSelected={section.id === selectedSectionId}
              commentCount={commentCounts[section.id] ?? 0}
              comments={commentsBySection[section.id] ?? []}
              onCommentsChange={onSectionCommentsChange}
              onSelect={onSelectSection}
              canWrite={canWrite}
              canEdit={canEdit}
              commentsCollapsed={commentsCollapsed}
              onExpandComments={onExpandComments}
              /* spec-178 ac-24: a frozen demo spec suppresses handle auto-linking. */
              isDemo={doc.isDemo ?? false}
              /* spec-325 (dec-1): hand the comment deep-link's seq to every section;
                 the owning one pins it in situ on load (emulating a card click). */
              deepLinkCommentSeq={deepLinkCommentSeq}
            />
          </div>
        ))}
      </div>
      <aside className="w-48 shrink-0 hidden lg:block sticky top-4 self-start max-h-[calc(100vh-6rem)] overflow-y-auto">
        <DocOutline
          doc={doc}
          sections={narrativeSections}
          activeSectionId={selectedSectionId}
          commentCounts={commentCounts}
          onSectionClick={onOutlineSectionClick}
        />
      </aside>
    </div>
  );
}
