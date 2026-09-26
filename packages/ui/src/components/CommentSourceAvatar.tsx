import type { CommentSource } from '../api/types';
import { Avatar } from './ui/Avatar';
import { useAvatarChoice } from './AvatarRoster';

interface CommentSourceAvatarProps {
  /** 'agent' renders the robot glyph + indigo ring; 'human' (or omitted) renders the person's avatar. */
  source: CommentSource | undefined | null;
  /** Author display name, stamped on the comment at write time. */
  authorName: string;
  /** The author's user id, when known: looks up their chosen avatar letters and colour. */
  authorUserId?: string | null;
  className?: string;
}

/**
 * Avatar that visually distinguishes human-authored from agent-authored comments.
 * Per Section 7:
 *   - human → the person's avatar (spec-574: the same one they have everywhere)
 *   - agent → robot icon, indigo accent border
 *
 * The "robot" glyph is a single Unicode character so we don't ship an icon library just
 * for this. `data-comment-source` exposes the source for tests.
 */
export function CommentSourceAvatar({
  source,
  authorName,
  authorUserId,
  className = '',
}: CommentSourceAvatarProps) {
  const isAgent = source === 'agent';
  const choice = useAvatarChoice(isAgent ? null : authorUserId);

  if (isAgent) {
    return (
      <span
        data-testid="comment-source-avatar"
        data-comment-source="agent"
        title={`${authorName} (agent)`}
        aria-label={`Agent: ${authorName}`}
        className={`inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-medium leading-none w-5 h-5 bg-indigo-500 text-white ring-2 ring-indigo-300 dark:ring-indigo-700 ${className}`}
      >
        {/* Robot glyph (U+1F916). Visually compact and language-agnostic. */}
        <span aria-hidden="true">🤖</span>
      </span>
    );
  }

  return (
    <span
      data-testid="comment-source-avatar"
      data-comment-source="human"
      title={authorName}
      aria-label={`Human: ${authorName}`}
      className={`inline-flex shrink-0 ${className}`}
    >
      <Avatar
        person={{
          name: authorName,
          avatarLabel: choice?.avatarLabel,
          avatarColor: choice?.avatarColor,
        }}
        size="sm"
        decorative
      />
    </span>
  );
}
