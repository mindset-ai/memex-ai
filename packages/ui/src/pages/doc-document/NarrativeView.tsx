import type { Comment, DocSection, DocWithGraph } from '../../api/types';
import { SectionCard } from '../../components/SectionCard';
import { DocOutline } from '../../components/DocOutline';

// spec-362 (dec-1, sol-3): the Specify "Narrative" sub-tab view, extracted
// verbatim out of DocDocument's body. It renders the narrative section list
// (qa_report sections already excluded by the caller) plus the sticky outline
// aside. Sections render eagerly — identical to the markup before this Spec.
//
// perf-6 (virtualization) is DEFERRED — see dec-1 (amended). The first attempt
// wrapped each section in `content-visibility: auto` + `contain-intrinsic-size`
// to skip off-screen layout/paint. That kept the DOM mounted (so the cross-list
// coupling stayed intact) but introduced continuous layout correction as the
// browser reconciled each skipped section's *estimated* intrinsic size against
// its real height on scroll/measure. On the slower CI runner that reflow never
// settled, so the selection toolbar (positioned relative to the live selection)
// never reached Playwright's "stable" actionability state and journey-37 /
// journey-40 timed out DETERMINISTICALLY (passing locally only because a fast
// machine settles the reflow within the action timeout). CSS content-visibility
// is therefore the wrong tool for this surface; real windowing (a measured
// virtual list that doesn't shift the layout under an open selection) is the
// follow-up. This Spec ships the SOLID extraction only.

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
          <SectionCard
            key={section.id}
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
