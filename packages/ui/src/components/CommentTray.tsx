import { useState, useRef } from 'react';
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
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
