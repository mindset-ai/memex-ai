import { useMemo, useState, useRef } from 'react';
import type { Comment, CommentTargetType } from '../api/types';
import { useAuth } from './AuthContext';
import {
  createComment,
  createDecisionComment,
  createTaskComment,
  resolveComment as apiResolveComment,
  unresolveComment as apiUnresolveComment,
  type CommentExtras,
} from '../api/client';
import { TextArea } from './ui/TextArea';
import { Button } from './ui';
import { CommentTypePill } from './CommentTypePill';
import { CommentSourceAvatar } from './CommentSourceAvatar';
import { DecisionLink, TaskLink, parseEntityRefs } from './DecisionLink';
import {
  FILTER_CHIP_TYPES,
  commentTypeAccentBorder,
  commentTypeLabel,
  type FilterChipType,
} from '../utils/commentStyles';

interface CommentTrayProps {
  targetType: CommentTargetType;
  targetId: string;
  comments: Comment[];
  onCommentsChange?: (targetId: string, comments: Comment[]) => void;
  /**
   * spec-111 t-8: when false (a non-member reading a public Memex), every
   * mutation affordance is suppressed — the comment composer and the
   * resolve/reopen actions on each bubble. The comment LIST still renders
   * (read-only). Defaults to true so existing member call sites are unchanged.
   */
  canWrite?: boolean;
  /**
   * spec-164 dec-6: when true (the task tray), agent-generated chatter —
   * `plan` / `progress` typed comments — is hidden from the default "All"
   * view behind its existing type chips, which act as the default-off
   * filter. Human-loop types (review / question / drift / plan_revision /
   * discussion) still auto-surface. Counts keep reflecting ALL open
   * comments so hidden chatter stays discoverable. Defaults to false so
   * section/decision trays are unchanged.
   */
  muteAgentChatter?: boolean;
}

type ChipFilter = 'all' | FilterChipType;

// The agent-chatter comment types dec-6 mutes by default in the task tray.
const AGENT_CHATTER_TYPES: ReadonlyArray<string> = ['plan', 'progress'];

function isAgentChatter(comment: Comment): boolean {
  return AGENT_CHATTER_TYPES.includes(comment.commentType ?? 'discussion');
}

interface CommentFilterChipsProps {
  active: ChipFilter;
  onChange: (next: ChipFilter) => void;
  /**
   * Optional per-type counts. When provided, each chip renders its count;
   * chips with zero count are still rendered so the row stays stable as the
   * user filters.
   */
  counts?: Partial<Record<ChipFilter, number>>;
}

/**
 * Filter chip row shown above CommentTray and AllComments. Per Section 7 of
 * doc-10: All / Plan / Progress / Question / Issue / Drift. The same component
 * is exported for reuse so the doc-wide view in AllComments stays visually
 * consistent with the per-target tray.
 */
export function CommentFilterChips({ active, onChange, counts }: CommentFilterChipsProps) {
  const chips: ChipFilter[] = ['all', ...FILTER_CHIP_TYPES];
  return (
    <div data-testid="comment-filter-chips" className="flex flex-wrap gap-1.5 mb-2">
      {chips.map((chip) => {
        const label = chip === 'all' ? 'All' : commentTypeLabel(chip);
        const count = counts?.[chip];
        const isActive = active === chip;
        return (
          <button
            key={chip}
            type="button"
            data-testid={`comment-filter-${chip}`}
            data-active={isActive ? 'true' : 'false'}
            onClick={() => onChange(isActive ? 'all' : chip)}
            className={`text-[11px] rounded-full px-2 py-0.5 border transition-colors ${
              isActive
                ? 'bg-accent text-white border-accent'
                : 'bg-overlay text-secondary border-divider hover:border-accent/50'
            }`}
          >
            {label}
            {count !== undefined ? ` · ${count}` : ''}
          </button>
        );
      })}
    </div>
  );
}

function matchesFilter(comment: Comment, filter: ChipFilter): boolean {
  if (filter === 'all') return true;
  return (comment.commentType ?? 'discussion') === filter;
}

export function CommentTray({ targetType, targetId, comments, onCommentsChange, canWrite = true, muteAgentChatter = false }: CommentTrayProps) {
  const { user } = useAuth();
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [filter, setFilter] = useState<ChipFilter>('all');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const counts = useMemo(() => {
    const open = comments.filter((c) => !c.resolvedAt);
    const out: Partial<Record<ChipFilter, number>> = { all: open.length };
    for (const t of FILTER_CHIP_TYPES) {
      out[t] = open.filter((c) => (c.commentType ?? 'discussion') === t).length;
    }
    return out;
  }, [comments]);

  // spec-164 dec-6: on the default "All" view of a muted tray, agent chatter
  // (plan/progress) is excluded — selecting its chip reveals it. Explicit
  // chip selections are never muted.
  const chatterMuted = muteAgentChatter && filter === 'all';
  const openComments = comments
    .filter((c) => !c.resolvedAt)
    .filter((c) => matchesFilter(c, filter))
    .filter((c) => !(chatterMuted && isAgentChatter(c)));
  const resolvedComments = comments
    .filter((c) => c.resolvedAt)
    .filter((c) => matchesFilter(c, filter))
    .filter((c) => !(chatterMuted && isAgentChatter(c)));
  const hiddenChatterCount = chatterMuted
    ? comments.filter((c) => !c.resolvedAt && isAgentChatter(c)).length
    : 0;

  const updateComments = (updated: Comment[]) => {
    onCommentsChange?.(targetId, updated);
  };

  const authorName = user?.name ?? 'Anonymous';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    setSubmitting(true);
    // Humans don't classify their comments — every human comment is a freeform
    // 'discussion'. Pass undefined so the wire stays minimal and the server's REST
    // default ('human' source, no type → discussion) takes effect. (spec-153 removed
    // the human type picker; the typed taxonomy is an internal agent/system channel.)
    const extras: CommentExtras | undefined = undefined;
    try {
      let comment: Comment;
      if (targetType === 'decision') {
        comment = await createDecisionComment(targetId, authorName, content.trim(), extras);
      } else if (targetType === 'task') {
        comment = await createTaskComment(targetId, authorName, content.trim(), extras);
      } else {
        comment = await createComment(targetId, authorName, content.trim(), extras);
      }
      updateComments([...comments, comment]);
      setContent('');
    } catch (err) {
      console.error('Failed to add comment:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResolve = async (commentId: string) => {
    try {
      const updated = await apiResolveComment(commentId);
      updateComments(comments.map((c) => (c.id === commentId ? updated : c)));
    } catch (err) {
      console.error('Failed to resolve:', err);
    }
  };

  const handleUnresolve = async (commentId: string) => {
    try {
      const updated = await apiUnresolveComment(commentId);
      updateComments(comments.map((c) => (c.id === commentId ? updated : c)));
    } catch (err) {
      console.error('Failed to unresolve:', err);
    }
  };

  return (
    <div data-testid="comment-tray" className="flex flex-col">
      {comments.some((c) => !c.resolvedAt) && (
        <CommentFilterChips active={filter} onChange={setFilter} counts={counts} />
      )}

      {/* spec-164 dec-6: discoverability line for muted agent chatter — the
          count badge upstream already includes it; this names where it went. */}
      {hiddenChatterCount > 0 && (
        <p data-testid="comment-chatter-note" className="text-[11px] text-muted mb-2">
          {hiddenChatterCount} agent update{hiddenChatterCount === 1 ? '' : 's'} hidden — use
          the Plan / Progress chips to show {hiddenChatterCount === 1 ? 'it' : 'them'}.
        </p>
      )}

      {/* Comment list */}
      <div className="space-y-3">
        {openComments.length === 0 && filter !== 'all' && (
          <p className="text-xs text-muted">No {commentTypeLabel(filter).toLowerCase()} comments.</p>
        )}

        {openComments.map((comment) => (
          <div key={comment.id} data-testid="comment-item" data-comment-id={comment.id}>
            <CommentBubble
              comment={comment}
              onResolve={canWrite ? () => handleResolve(comment.id) : undefined}
            />
          </div>
        ))}

        {resolvedComments.length > 0 && (
          <div>
            <button
              onClick={() => setShowResolved((v) => !v)}
              className="text-xs text-muted hover:text-secondary transition-colors"
            >
              {showResolved ? 'Hide' : 'Show'} {resolvedComments.length} resolved
            </button>
            {showResolved && (
              <div className="mt-2 space-y-3">
                {resolvedComments.map((comment) => (
                  <CommentBubble
                    key={comment.id}
                    comment={comment}
                    onUnresolve={canWrite ? () => handleUnresolve(comment.id) : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input — hidden for read-only (non-member) viewers (spec-111 t-8). */}
      {canWrite && (
      <form onSubmit={handleSubmit} className="mt-3 space-y-2">
        <TextArea
          ref={inputRef}
          data-testid="comment-textarea"
          placeholder="Add a comment..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
          textAreaSize="compact"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              handleSubmit(e);
            }
          }}
        />
        <Button
          data-testid="comment-submit"
          type="submit"
          disabled={submitting || !content.trim()}
          className="w-full"
          size="sm"
        >
          {submitting ? 'Posting...' : 'Post'}
        </Button>
      </form>
      )}
    </div>
  );
}

export function CommentBubble({
  comment,
  sectionTitle,
  onResolve,
  onUnresolve,
  onNavigate,
}: {
  comment: Comment;
  sectionTitle?: string;
  onResolve?: () => void;
  onUnresolve?: () => void;
  onNavigate?: () => void;
}) {
  const isResolved = !!comment.resolvedAt;
  const isAgent = comment.source === 'agent';
  const accent = isAgent ? `border-l-2 ${commentTypeAccentBorder(comment.commentType)}` : '';
  const date = new Date(comment.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div
      data-comment-source={comment.source ?? 'human'}
      data-comment-type={comment.commentType ?? 'discussion'}
      className={`group rounded-md p-2.5 ${accent} ${isResolved ? 'opacity-50' : 'bg-overlay'}`}
    >
      {sectionTitle && onNavigate && (
        <button
          onClick={onNavigate}
          className="text-xs text-accent/70 hover:text-accent transition-colors mb-1 truncate block max-w-full text-left"
        >
          {sectionTitle}
        </button>
      )}
      {comment.referenceType && comment.referenceId && (
        <div className="text-[11px] text-muted mb-1">
          ref: {comment.referenceType} → {comment.referenceId}
        </div>
      )}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <CommentSourceAvatar source={comment.source} authorName={comment.authorName} />
          <span className="text-xs font-medium text-primary truncate">{comment.authorName}</span>
          <CommentTypePill type={comment.commentType} hideForDiscussion />
        </div>
        <span className="text-xs text-muted shrink-0">{date}</span>
      </div>
      <p className="text-sm text-primary whitespace-pre-wrap">
        {parseEntityRefs(comment.content).map((seg, i) =>
          seg.kind === 'text' ? (
            <span key={i}>{seg.value}</span>
          ) : seg.kind === 'dec' ? (
            // b-42 t-2: scope bare-handle resolution to the comment's parent
            // doc so memexes with dec-1 / t-1 in multiple Specs don't 409.
            <DecisionLink key={i} handle={seg.value} parentDocId={comment.docId} />
          ) : (
            <TaskLink key={i} handle={seg.value} parentDocId={comment.docId} />
          ),
        )}
      </p>
      <div className="mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {!isResolved && onResolve && (
          <button
            onClick={onResolve}
            className="text-xs text-status-success-text hover:text-status-success-text/80 transition-colors"
          >
            Resolve
          </button>
        )}
        {isResolved && onUnresolve && (
          <button
            onClick={onUnresolve}
            className="text-xs text-status-warning-text hover:text-status-warning-text/80 transition-colors"
          >
            Reopen
          </button>
        )}
      </div>
    </div>
  );
}
