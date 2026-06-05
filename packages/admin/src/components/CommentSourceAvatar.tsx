import type { CommentSource } from '../api/types';

interface CommentSourceAvatarProps {
  /** 'agent' renders the robot glyph + indigo ring; 'human' (or omitted) renders initials. */
  source: CommentSource | undefined | null;
  /** Author display name — used to derive initials for human avatars. */
  authorName: string;
  /** Tailwind size class — defaults to a 5×5 (20px) bubble that fits inline next to the
   *  author name. */
  className?: string;
}

/** Compute up to 2 initials from a name like "Barrie Hadfield" → "BH". Falls back to "?". */
function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Avatar that visually distinguishes human-authored from agent-authored comments.
 * Per Section 7:
 *   - human → user initials, neutral border
 *   - agent → robot icon, indigo accent border
 *
 * The "robot" glyph is a single Unicode character so we don't ship an icon library just
 * for this. Tailwind classes provide both the colour and size; `data-comment-source`
 * exposes the source for tests.
 */
export function CommentSourceAvatar({
  source,
  authorName,
  className = '',
}: CommentSourceAvatarProps) {
  const isAgent = source === 'agent';
  const base =
    'inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-medium leading-none w-5 h-5';
  const variant = isAgent
    ? 'bg-indigo-500 text-white ring-2 ring-indigo-300 dark:ring-indigo-700'
    : 'bg-btn-secondary text-secondary border border-divider';

  return (
    <span
      data-testid="comment-source-avatar"
      data-comment-source={isAgent ? 'agent' : 'human'}
      title={isAgent ? `${authorName} (agent)` : authorName}
      aria-label={isAgent ? `Agent: ${authorName}` : `Human: ${authorName}`}
      className={`${base} ${variant} ${className}`}
    >
      {isAgent ? (
        // Robot glyph (U+1F916). Visually compact and language-agnostic.
        <span aria-hidden="true">🤖</span>
      ) : (
        <span aria-hidden="true">{initialsOf(authorName)}</span>
      )}
    </span>
  );
}
