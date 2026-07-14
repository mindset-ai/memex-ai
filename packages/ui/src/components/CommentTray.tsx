import { useState, useEffect } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeRefLinkifier } from './chat/refLinkifier';
import { rehypePerRefLinkifier } from './chat/perRefLinkifier';
import type { Comment, CommentTargetType } from '../api/types';
import { useAuth } from './AuthContext';
import {
  createComment,
  createDecisionComment,
  createTaskComment,
  resolveComment as apiResolveComment,
  unresolveComment as apiUnresolveComment,
  addCommentMentions,
  assignComment as apiAssignComment,
  fetchCommentMentions,
  type CommentExtras,
  type CommentMentionView,
} from '../api/client';
import { MentionComposer, type MentionSubmit } from './MentionComposer';
import { CommentTypePill } from './CommentTypePill';
import { CommentSourceAvatar } from './CommentSourceAvatar';
import { DecisionLink, TaskLink } from './DecisionLink';
import { commentTypeAccentBorder } from '../utils/commentStyles';
// spec-259 ac-5: render WHEN as the SAME relative phrase the MCP/agent surface
// uses ("3d ago") so the web Specify readiness picture matches the agent's.
import { timeAgo } from '../utils/timeAgo';

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
   * `plan` / `progress` typed comments — is hidden from the default view.
   * Human-loop types (review / question / drift / plan_revision /
   * discussion) still auto-surface, and a discoverability note names the
   * hidden count. Defaults to false so section/decision trays are unchanged.
   *
   * spec-185: the comment-type filter chips were removed, so the chip-based
   * reveal is gone — hidden chatter is surfaced via the count note only.
   */
  muteAgentChatter?: boolean;
}

// The agent-chatter comment types dec-6 mutes by default in the task tray.
const AGENT_CHATTER_TYPES: ReadonlyArray<string> = ['plan', 'progress'];

function isAgentChatter(comment: Comment): boolean {
  return AGENT_CHATTER_TYPES.includes(comment.commentType ?? 'discussion');
}

export function CommentTray({ targetType, targetId, comments, onCommentsChange, canWrite = true, muteAgentChatter = false }: CommentTrayProps) {
  const { user } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  // spec-320: mentions per comment, for rendering chips + resolving the assignee's
  // display name (the assignee is also a mention).
  const [mentionsByComment, setMentionsByComment] = useState<Record<string, CommentMentionView[]>>({});

  const loadMentions = async (ids: string[]) => {
    if (ids.length === 0) {
      setMentionsByComment({});
      return;
    }
    try {
      setMentionsByComment(await fetchCommentMentions(ids));
    } catch {
      // Non-fatal: chips just don't render.
    }
  };

  const commentIdsKey = comments.map((c) => c.id).join(',');
  useEffect(() => {
    void loadMentions(comments.map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentIdsKey]);

  // spec-164 dec-6: in a muted tray (the task tray) agent chatter
  // (plan/progress) is hidden by default and a discoverability note names the
  // hidden count. spec-185 removed the comment-type chip row, so there is no
  // longer a chip to reveal it — muting is gated on the opt-in alone.
  const chatterMuted = muteAgentChatter;
  const openComments = comments
    .filter((c) => !c.resolvedAt)
    .filter((c) => !(chatterMuted && isAgentChatter(c)));
  const resolvedComments = comments
    .filter((c) => c.resolvedAt)
    .filter((c) => !(chatterMuted && isAgentChatter(c)));
  const hiddenChatterCount = chatterMuted
    ? comments.filter((c) => !c.resolvedAt && isAgentChatter(c)).length
    : 0;

  const updateComments = (updated: Comment[]) => {
    onCommentsChange?.(targetId, updated);
  };

  const authorName = user?.name ?? 'Anonymous';

  // spec-320: create the comment, then attach @-mentions and (optionally) the
  // assignee. Humans don't classify their comments — every human comment is a
  // freeform 'discussion' (extras undefined → server defaults).
  const handleComposerSubmit = async ({ content, mentionUserIds, assigneeUserId }: MentionSubmit) => {
    const extras: CommentExtras | undefined = undefined;
    setSubmitting(true);
    try {
      let comment: Comment;
      if (targetType === 'decision') {
        comment = await createDecisionComment(targetId, authorName, content, extras);
      } else if (targetType === 'task') {
        comment = await createTaskComment(targetId, authorName, content, extras);
      } else {
        comment = await createComment(targetId, authorName, content, extras);
      }
      if (mentionUserIds.length > 0) {
        await addCommentMentions(comment.id, mentionUserIds);
      }
      if (assigneeUserId) {
        // Returns the comment with assignee columns set (assign = mention + ownership).
        comment = await apiAssignComment(comment.id, assigneeUserId);
      }
      const next = [...comments, comment];
      updateComments(next);
      await loadMentions(next.map((c) => c.id));
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
      {/* spec-164 dec-6: discoverability line for muted agent chatter — names
          the hidden count. (spec-185 removed the chip-based reveal.) */}
      {hiddenChatterCount > 0 && (
        <p data-testid="comment-chatter-note" className="text-[11px] text-muted mb-2">
          {hiddenChatterCount} agent update{hiddenChatterCount === 1 ? '' : 's'} hidden.
        </p>
      )}

      {/* Comment list */}
      <div className="space-y-3">
        {openComments.map((comment) => (
          <div key={comment.id} data-testid="comment-item" data-comment-id={comment.id}>
            <CommentBubble
              comment={comment}
              mentions={mentionsByComment[comment.id] ?? []}
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
                    mentions={mentionsByComment[comment.id] ?? []}
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
        <MentionComposer submitting={submitting} onSubmit={handleComposerSubmit} />
      )}
    </div>
  );
}

function mentionLabel(m: CommentMentionView): string {
  return m.name?.trim() || m.email?.trim() || 'Unknown';
}

/**
 * spec-484 dec-2 (ac-6 / ac-9): comment bodies are human- OR LLM-authored and
 * legitimately contain markdown, so they render as real markdown instead of
 * literal `**bold**` / `- list` / `[link](url)` text.
 *
 * Both ref syntaxes stay linkified in one render pass by running BOTH rehype
 * plugins: `rehypeRefLinkifier` (full canonical paths) + `rehypePerRefLinkifier`
 * (the `[per dec-N]` / `[per t-N]` shorthand). The shorthand plugin stamps
 * `data-per-ref` / `data-per-handle` on its anchors; the `a` component mapping
 * below upgrades those into interactive `<DecisionLink>` / `<TaskLink>` so the
 * exact resolve-on-click + navigate affordance survives the move onto the
 * markdown path (the crux of spec-484 t-2). Plain markdown links render as
 * external anchors, matching MarkdownText's block mode.
 *
 * Exported so SectionCard's comment popover renders comment bodies identically.
 */
export function CommentMarkdown({
  content,
  parentDocId,
  className = 'text-primary',
}: {
  content: string;
  /** b-42 t-2: scope bare-handle resolution to the comment's parent doc. */
  parentDocId?: string;
  className?: string;
}) {
  const components: Components = {
    a: ({ children, href, node }) => {
      const props = (node?.properties ?? {}) as Record<string, unknown>;
      const perRef = (props['data-per-ref'] ?? props['dataPerRef']) as
        | string
        | undefined;
      if (perRef) {
        const handle = String(
          props['data-per-handle'] ?? props['dataPerHandle'] ?? '',
        );
        return perRef === 'task' ? (
          <TaskLink handle={handle} parentDocId={parentDocId} />
        ) : (
          <DecisionLink handle={handle} parentDocId={parentDocId} />
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline text-accent hover:text-accent/80"
        >
          {children}
        </a>
      );
    },
  };
  return (
    <div
      className={`text-sm ${className} [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded-sm [&_code]:bg-overlay [&_code]:text-xs`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRefLinkifier, rehypePerRefLinkifier]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function CommentBubble({
  comment,
  sectionTitle,
  mentions = [],
  onResolve,
  onUnresolve,
  onNavigate,
}: {
  comment: Comment;
  sectionTitle?: string;
  mentions?: CommentMentionView[];
  onResolve?: () => void;
  onUnresolve?: () => void;
  onNavigate?: () => void;
}) {
  const isResolved = !!comment.resolvedAt;
  // spec-320: the assignee is also a mention — resolve its display name from the
  // mention set rather than a second lookup.
  const assignee = comment.assigneeUserId
    ? mentions.find((m) => m.userId === comment.assigneeUserId)
    : undefined;
  const isAgent = comment.source === 'agent';
  const accent = isAgent ? `border-l-2 ${commentTypeAccentBorder(comment.commentType)}` : '';
  const absoluteDate = new Date(comment.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  // spec-259 ac-5: WHEN is a relative phrase matching the agent surface; the
  // exact timestamp stays available on hover.
  const relative = timeAgo(comment.createdAt);

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
          <span
            className="text-xs font-medium text-primary truncate"
            data-testid="comment-byline-author"
          >
            {comment.authorName}
          </span>
          <CommentTypePill type={comment.commentType} hideForDiscussion />
        </div>
        <span
          className="text-xs text-muted shrink-0"
          title={absoluteDate}
          data-testid="comment-byline-when"
        >
          {relative}
        </span>
      </div>
      {/* spec-484 dec-2 (ac-6 / ac-9): the body renders as markdown; both ref
          syntaxes stay linkified via CommentMarkdown's dual rehype plugins.
          b-42 t-2: bare-handle resolution is scoped to the comment's parent doc
          so memexes with dec-1 / t-1 in multiple Specs don't 409. */}
      <CommentMarkdown content={comment.content} parentDocId={comment.docId} />
      {(mentions.length > 0 || assignee) && (
        <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="comment-mentions">
          {assignee && (
            <span
              data-testid="comment-assignee"
              data-user-id={assignee.userId}
              className="inline-flex h-5 items-center rounded-full bg-accent/15 px-2 text-[10px] font-medium text-accent"
            >
              Assigned to {mentionLabel(assignee)}
            </span>
          )}
          {mentions
            .filter((m) => m.userId !== comment.assigneeUserId)
            .map((m) => (
              <span
                key={m.userId}
                data-testid="comment-mention-chip"
                data-user-id={m.userId}
                className="inline-flex h-5 items-center rounded-full bg-overlay px-2 text-[10px] text-muted"
              >
                @{mentionLabel(m)}
              </span>
            ))}
        </div>
      )}
      <div className="mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {/* spec-247: "Resolve" alone reads as resolving the DECISION the
            comment sits on — name the actual effect. */}
        {!isResolved && onResolve && (
          <button
            onClick={onResolve}
            className="text-xs text-status-success-text hover:text-status-success-text/80 transition-colors"
          >
            Resolve Comment
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
