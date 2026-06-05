// spec-100 ac-9: the Comments-tab filter predicate. The load-bearing filters
// are author kind (human vs system) and status (open vs resolved); type is a
// secondary filter. The four user-facing comment types are not redefined here —
// this only filters on them, it does not ascribe new meaning.
//
// Pure + framework-free so it can be unit-tested without React and reused by
// both the Comments tab and the spec-view marker dimming.

import type { Comment, CommentType } from '../api/types';

export type AuthorKindFilter = 'all' | 'human' | 'system';
export type StatusFilter = 'all' | 'open' | 'resolved';

export interface CommentFilter {
  authorKind: AuthorKindFilter;
  status: StatusFilter;
  type: CommentType | null;
}

// The default the Comments tab opens with: every author, open only (resolved
// comments are history, surfaced on demand), no type filter.
export function defaultCommentFilter(): CommentFilter {
  return { authorKind: 'all', status: 'open', type: null };
}

// A comment's author kind: agent-sourced comments are "system"; everything else
// (including legacy rows with no source) is "human".
export function authorKindOf(comment: Comment): 'human' | 'system' {
  return comment.source === 'agent' ? 'system' : 'human';
}

function matchesAuthorKind(comment: Comment, filter: AuthorKindFilter): boolean {
  if (filter === 'all') return true;
  return authorKindOf(comment) === filter;
}

function matchesStatus(comment: Comment, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  const open = comment.resolvedAt == null;
  return filter === 'open' ? open : !open;
}

function matchesType(comment: Comment, type: CommentType | null): boolean {
  if (type === null) return true;
  return (comment.commentType ?? 'discussion') === type;
}

export function filterComments(comments: Comment[], filter: CommentFilter): Comment[] {
  return comments.filter(
    (c) =>
      matchesAuthorKind(c, filter.authorKind) &&
      matchesStatus(c, filter.status) &&
      matchesType(c, filter.type),
  );
}
