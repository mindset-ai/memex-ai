import type { CommentType } from '../api/types';
import { commentTypeLabel, commentTypePillClass } from '../utils/commentStyles';

interface CommentTypePillProps {
  type: CommentType | undefined | null;
  /** When true, renders nothing for the default `discussion` type — keeps legacy / human
   *  freeform comments visually clean. Defaults to false (always render). */
  hideForDiscussion?: boolean;
  className?: string;
}

/**
 * Small coloured pill rendered next to the author name. Colour palette per Section 7 of
 * doc-10. Used by CommentBubble in CommentTray; also reused on agent-authored chat tool
 * widgets if/when those land.
 *
 * The 12 distinct colour mappings live in `utils/commentStyles.ts` so that adding a new
 * type (or tweaking a hue) happens in exactly one place — the style file is the single
 * source of truth for both the pill and the agent-source accent border.
 */
export function CommentTypePill({
  type,
  hideForDiscussion = false,
  className = '',
}: CommentTypePillProps) {
  if (hideForDiscussion && (type === 'discussion' || !type)) {
    return null;
  }
  return (
    <span
      data-testid="comment-type-pill"
      data-comment-type={type ?? 'discussion'}
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${commentTypePillClass(type)} ${className}`}
    >
      {commentTypeLabel(type)}
    </span>
  );
}
