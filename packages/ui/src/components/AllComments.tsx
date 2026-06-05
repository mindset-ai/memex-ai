import { useMemo, useState } from 'react';
import type { Comment, CommentType, DocSection, Decision, Task } from '../api/types';
import { CommentBubble, CommentFilterChips } from './CommentTray';
import { FILTER_CHIP_TYPES, commentTypeLabel, type FilterChipType } from '../utils/commentStyles';
import {
  filterComments,
  type AuthorKindFilter,
  type StatusFilter,
} from '../utils/filterComments';
import { commentAnchorId, buildCommentLink } from '../utils/commentDeepLink';

type ChipFilter = 'all' | FilterChipType;

// spec-100 ac-6: wrap a comment with a stable scroll anchor (`comment-c-{seq}`)
// and a copy-link button so a viewer can be taken straight to it.
function AnchoredCommentBubble({ comment }: { comment: Comment }) {
  const seq = comment.seq;
  const copyLink = () => {
    if (seq === undefined) return;
    const link = buildCommentLink(window.location.href, seq);
    void navigator.clipboard?.writeText(link);
  };
  return (
    <div id={seq !== undefined ? commentAnchorId(seq) : undefined} className="group/clink relative">
      <CommentBubble comment={comment} />
      {seq !== undefined && (
        <button
          type="button"
          data-testid={`comment-copy-link-${seq}`}
          aria-label="Copy link to this comment"
          title="Copy link to this comment"
          onClick={copyLink}
          className="absolute top-1 right-1 opacity-0 group-hover/clink:opacity-100 transition-opacity text-[10px] text-muted hover:text-accent"
        >
          🔗
        </button>
      )}
    </div>
  );
}

// spec-100 ac-9: author kind + status are the load-bearing Comments-tab
// filters. Small segmented control mirroring the type-chip styling.
const AUTHOR_KIND_OPTIONS: { value: AuthorKindFilter; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'system', label: 'System' },
  { value: 'human', label: 'People' },
];
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
];

function SegmentedFilter<T extends string>({
  group,
  options,
  active,
  onChange,
}: {
  group: string;
  options: { value: T; label: string }[];
  active: T;
  onChange: (next: T) => void;
}) {
  return (
    <div data-testid={`${group}-filter`} className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const isActive = active === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            data-testid={`${group}-filter-${opt.value}`}
            data-active={isActive ? 'true' : 'false'}
            onClick={() => onChange(opt.value)}
            className={`text-[11px] rounded-full px-2 py-0.5 border transition-colors ${
              isActive
                ? 'bg-accent text-white border-accent'
                : 'bg-overlay text-secondary border-divider hover:border-accent/50'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

interface AllCommentsProps {
  sections: DocSection[];
  decisions?: Decision[];
  tasks?: Task[];
  commentsBySection: Record<string, Comment[]>;
  commentsByDecision?: Record<string, Comment[]>;
  commentsByTask?: Record<string, Comment[]>;
  onNavigateToSection: (sectionId: string) => void;
  onTabChange?: (tab: string) => void;
  // t-19 W3.3: chip filter is owned by the parent (DocDocument) so a chip click
  // drives a server-side `?type=` refetch via fetchDocComments instead of a
  // client-side filter pass after the fact. `null` means "All".
  filter?: CommentType | null;
  onFilterChange?: (next: CommentType | null) => void;
}

export function AllComments({
  sections,
  decisions = [],
  tasks = [],
  commentsBySection,
  commentsByDecision = {},
  commentsByTask = {},
  onNavigateToSection,
  onTabChange,
  filter = null,
  onFilterChange,
}: AllCommentsProps) {
  // spec-100 ac-9: author kind + status are the load-bearing filters, owned
  // locally (no refetch needed — both fields are already on the loaded rows).
  // Status defaults to 'open'; resolved comments are history, shown on demand.
  const [authorKind, setAuthorKind] = useState<AuthorKindFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('open');
  const applyLocal = (list: Comment[]) =>
    filterComments(list, { authorKind, status, type: null });
  // Doc-wide chip counts. With server-side filtering active, these counts only
  // reflect the comments the server returned for the current filter — when the
  // filter is "All" they represent every open comment in the doc; when a
  // specific filter is active they show how many are in *that* set. Per the
  // t-19 W3.3 spec we accept this as a deliberate UX trade-off: counts now
  // describe "what's loaded" rather than "what exists across all types".
  const counts = useMemo(() => {
    const allOpen: Comment[] = [];
    for (const list of Object.values(commentsBySection)) {
      for (const c of list) if (!c.resolvedAt) allOpen.push(c);
    }
    for (const list of Object.values(commentsByDecision)) {
      for (const c of list) if (!c.resolvedAt) allOpen.push(c);
    }
    for (const list of Object.values(commentsByTask)) {
      for (const c of list) if (!c.resolvedAt) allOpen.push(c);
    }
    const out: Partial<Record<ChipFilter, number>> = { all: allOpen.length };
    for (const t of FILTER_CHIP_TYPES) {
      out[t] = allOpen.filter((c) => (c.commentType ?? 'discussion') === t).length;
    }
    return out;
  }, [commentsBySection, commentsByDecision, commentsByTask]);

  // The parent has already narrowed by type (server-side ?type=); author kind
  // and status are applied here client-side over that slice.
  const sectionEntries = sections
    .map((section, index) => ({
      section,
      index,
      comments: applyLocal(commentsBySection[section.id] ?? []),
    }))
    .filter((e) => e.comments.length > 0);

  const decisionEntries = decisions
    .map((decision) => ({
      decision,
      comments: applyLocal(commentsByDecision[decision.id] ?? []),
    }))
    .filter((e) => e.comments.length > 0);

  const taskEntries = tasks
    .map((task) => ({
      task,
      comments: applyLocal(commentsByTask[task.id] ?? []),
    }))
    .filter((e) => e.comments.length > 0);

  // Filter controls show whenever the doc has any comment at all (open or
  // resolved), so the status filter can reach resolved history.
  const hasAnyComments =
    Object.values(commentsBySection).some((l) => l.length > 0) ||
    Object.values(commentsByDecision).some((l) => l.length > 0) ||
    Object.values(commentsByTask).some((l) => l.length > 0);

  const totalCount =
    sectionEntries.reduce((n, e) => n + e.comments.length, 0) +
    decisionEntries.reduce((n, e) => n + e.comments.length, 0) +
    taskEntries.reduce((n, e) => n + e.comments.length, 0);

  // Show the chip row whenever any open comment exists in the current view OR
  // when a filter is active (the user can clear it). Hidden only on a doc with
  // truly nothing to filter.
  const hasAnyOpen = (counts.all ?? 0) > 0 || filter !== null;

  // The chip row only renders the FILTER_CHIP_TYPES tuple; if the active filter
  // is set to a type outside that set (e.g. `discussion`), the chip row shows
  // "All" while the data is still server-filtered to the requested type.
  const activeChip: ChipFilter =
    filter && (FILTER_CHIP_TYPES as readonly string[]).includes(filter)
      ? (filter as FilterChipType)
      : 'all';
  const handleChipChange = (next: ChipFilter) => {
    if (!onFilterChange) return;
    onFilterChange(next === 'all' ? null : (next as CommentType));
  };

  return (
    <div className="space-y-6 ml-8">
      {hasAnyComments && (
        <div className="space-y-2">
          <SegmentedFilter
            group="author"
            options={AUTHOR_KIND_OPTIONS}
            active={authorKind}
            onChange={setAuthorKind}
          />
          <SegmentedFilter
            group="status"
            options={STATUS_OPTIONS}
            active={status}
            onChange={setStatus}
          />
        </div>
      )}

      {hasAnyOpen && (
        <CommentFilterChips
          active={activeChip}
          onChange={handleChipChange}
          counts={counts}
        />
      )}

      {totalCount === 0 && (
        <p className="text-sm text-muted py-8">
          {filter === null
            ? status === 'resolved'
              ? 'No resolved comments.'
              : authorKind === 'system'
                ? 'No system comments in this view.'
                : 'No open comments.'
            : `No ${commentTypeLabel(filter).toLowerCase()} comments.`}
        </p>
      )}

      {sectionEntries.length > 0 && (
        <div>
          <span className="text-xs font-medium text-muted uppercase tracking-wider">
            Sections
          </span>
          <div className="mt-3 space-y-4">
            {sectionEntries.map(({ section, index, comments }) => (
              <div key={section.id}>
                <button
                  onClick={() => onNavigateToSection(section.id)}
                  className="text-xs text-accent/70 hover:text-accent transition-colors mb-2"
                >
                  Section {index + 1} — {section.title || section.sectionType}
                </button>
                <div className="space-y-2 border-l-2 border-l-accent pl-3">
                  {comments.map((comment) => (
                    <AnchoredCommentBubble key={comment.id} comment={comment} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {decisionEntries.length > 0 && (
        <div>
          <span className="text-xs font-medium text-muted uppercase tracking-wider">
            Decisions
          </span>
          <div className="mt-3 space-y-4">
            {decisionEntries.map(({ decision, comments }) => (
              <div key={decision.id}>
                <button
                  onClick={() => onTabChange?.('decisions')}
                  className="text-xs text-accent/70 hover:text-accent transition-colors mb-2"
                >
                  Decision dec-{decision.seq} — {decision.title}
                </button>
                <div className="space-y-2 border-l-2 border-l-accent pl-3">
                  {comments.map((comment) => (
                    <AnchoredCommentBubble key={comment.id} comment={comment} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {taskEntries.length > 0 && (
        <div>
          <span className="text-xs font-medium text-muted uppercase tracking-wider">
            Tasks
          </span>
          <div className="mt-3 space-y-4">
            {taskEntries.map(({ task, comments }) => (
              <div key={task.id}>
                <button
                  onClick={() => onTabChange?.('tasks')}
                  className="text-xs text-accent/70 hover:text-accent transition-colors mb-2"
                >
                  Task t-{task.seq} — {task.title}
                </button>
                <div className="space-y-2 border-l-2 border-l-accent pl-3">
                  {comments.map((comment) => (
                    <AnchoredCommentBubble key={comment.id} comment={comment} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
