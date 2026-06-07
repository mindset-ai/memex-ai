import { useState } from 'react';
import type { Comment, DocSection, Decision, Task } from '../api/types';
import { CommentBubble } from './CommentTray';
import { filterComments, type AuthorKindFilter, type StatusFilter } from '../utils/filterComments';
import { commentAnchorId, buildCommentLink } from '../utils/commentDeepLink';

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

// spec-194 (dec-2): author-kind + status filters share one combined row.
// People → Humans (the `'human'` value is unchanged); the shared filterComments
// predicate stays intact. The two groups are tone-coloured to read as distinct:
// author = `agent` (violet), status = `accent` (blue) — both theme tokens with
// light + dark values.
const AUTHOR_KIND_OPTIONS: { value: AuthorKindFilter; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'system', label: 'System' },
  { value: 'human', label: 'Humans' },
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
  tone = 'accent',
}: {
  group: string;
  options: { value: T; label: string }[];
  active: T;
  onChange: (next: T) => void;
  /** spec-194 dec-2: which theme accent the chips use. 'accent' = blue (status),
   *  'agent' = violet (author-kind). Both tokens carry light + dark values. */
  tone?: 'accent' | 'agent';
}) {
  const activeCls =
    tone === 'agent'
      ? 'bg-agent text-white border-agent'
      : 'bg-accent text-white border-accent';
  const idleCls =
    tone === 'agent'
      ? 'bg-overlay text-secondary border-divider hover:border-agent/50'
      : 'bg-overlay text-secondary border-divider hover:border-accent/50';
  return (
    <div data-testid={`${group}-filter`} data-tone={tone} className="flex flex-wrap gap-1.5">
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
              isActive ? activeCls : idleCls
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
}: AllCommentsProps) {
  // spec-194 dec-2: author-kind + status are the local filters (type chips were
  // removed by spec-185). Status defaults to 'open'; resolved comments are
  // history, shown on demand. authorKind defaults to 'all' (Everyone).
  const [authorKind, setAuthorKind] = useState<AuthorKindFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('open');
  const applyLocal = (list: Comment[]) =>
    filterComments(list, { authorKind, status, type: null });

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

  return (
    <div className="space-y-6 ml-8">
      {hasAnyComments && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <SegmentedFilter
            group="author"
            options={AUTHOR_KIND_OPTIONS}
            active={authorKind}
            onChange={setAuthorKind}
            tone="agent"
          />
          <span aria-hidden className="h-4 w-px bg-edge-subtle" />
          <SegmentedFilter
            group="status"
            options={STATUS_OPTIONS}
            active={status}
            onChange={setStatus}
          />
        </div>
      )}

      {totalCount === 0 && (
        <p className="text-sm text-muted py-8">
          {status === 'resolved'
            ? 'No resolved comments.'
            : authorKind === 'system'
              ? 'No system comments in this view.'
              : 'No open comments.'}
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
