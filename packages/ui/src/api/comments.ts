// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import type { Comment, DocCommentsResult } from './types';
import { fetchWithRetry } from './http';
import { tBase } from './internal';

export async function fetchDocComments(
  docId: string,
  types?: ReadonlyArray<CommentType>,
): Promise<DocCommentsResult> {
  // ?type=plan,issue server-side filter (t-4 wired the REST surface; t-19 W3.3
  // routes the chip filter through it instead of the prior client-side filter pass).
  const qs = types && types.length > 0 ? `?type=${encodeURIComponent(types.join(","))}` : "";
  const res = await fetchWithRetry(`${tBase()}/comments/doc/${docId}${qs}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch document comments: ${res.status}`);
  }
  return res.json();
}

export async function fetchComments(sectionId: string): Promise<Comment[]> {
  const res = await fetchWithRetry(`${tBase()}/comments/section/${sectionId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch comments: ${res.status}`);
  }
  return res.json();
}

export async function createComment(
  sectionId: string,
  authorName: string,
  content: string,
  extras?: CommentExtras,
  // spec-100: when present, the comment is anchored in the section source.
  // `anchorOffset` is the END of the selection; `anchorStartOffset` (optional)
  // is the START — together they bracket the selection into a `[^c-Ns]…[^c-Ne]`
  // range. Without the start it's a single-point anchor at the end offset.
  anchorOffset?: number,
  anchorStartOffset?: number,
): Promise<Comment> {
  const body: Record<string, unknown> = { authorName, content };
  if (extras?.type !== undefined) body.type = extras.type;
  if (anchorOffset !== undefined) body.anchorOffset = anchorOffset;
  if (anchorStartOffset !== undefined) body.anchorStartOffset = anchorStartOffset;
  const res = await fetchWithRetry(`${tBase()}/comments/section/${sectionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to create comment: ${res.status}`);
  }
  return res.json();
}

// spec-143 dec-4: thread the optional resolution string through so the agent
// can stamp a distinct audit trail — Reject → 'rejected', Resolve → 'resolved'.
// Accepting is NOT one of these: it changes rule text, so it goes through the
// server's `accept_standard_change` verb, which applies the proposal's clause
// operations and stamps 'accepted' in the same transaction (spec-530 dec-4).
// The `/drift/proposals/:id/accept` route this comment used to name was deleted
// by spec-530 dec-6 — it had been unable to succeed since spec-161, and nothing
// here ever called it. Omitting the resolution POSTs an empty body, preserving
// the prior no-resolution behaviour.
export async function resolveComment(
  commentId: string,
  resolution?: string,
): Promise<Comment> {
  const init: RequestInit = { method: 'POST' };
  if (resolution !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify({ resolution });
  }
  const res = await fetchWithRetry(`${tBase()}/comments/${commentId}/resolve`, init);
  if (!res.ok) {
    throw new Error(`Failed to resolve comment: ${res.status}`);
  }
  return res.json();
}

export async function unresolveComment(commentId: string): Promise<Comment> {
  const res = await fetchWithRetry(`${tBase()}/comments/${commentId}/unresolve`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`Failed to unresolve comment: ${res.status}`);
  }
  return res.json();
}

// spec-100: delete your own comment (server enforces ownership → 403 otherwise).
export async function deleteComment(commentId: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/comments/${commentId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(`Failed to delete comment: ${res.status}`);
  }
}

// ── spec-320: comment @-mentions + assignment ───────────────────────────────

// An active org member offered in the @-mention typeahead (dec-4).
export interface MentionableMember {
  userId: string;
  name: string | null;
  email: string;
}

// A mention rendered on a comment (the assignee is also one of these).
export interface CommentMentionView {
  userId: string;
  name: string | null;
  email: string | null;
}

// spec-320 (ac-10): the @-mention typeahead data source. Active org members
// matching `query` by substring on name or email; a blank query returns the active
// roster (the composer opens it on `@`). Returns [] for personal memexes / anon.
export async function searchMentionableMembers(query: string): Promise<MentionableMember[]> {
  const res = await fetchWithRetry(
    `${tBase()}/comments/mentionable-users?q=${encodeURIComponent(query)}`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { members?: MentionableMember[] };
  return data.members ?? [];
}

// The mentions on a batch of comments, keyed by commentId — for rendering mention
// chips and resolving the assignee's display name (assignee ⊆ mentions).
export async function fetchCommentMentions(
  commentIds: string[],
): Promise<Record<string, CommentMentionView[]>> {
  if (commentIds.length === 0) return {};
  const res = await fetchWithRetry(
    `${tBase()}/comments/mentions?ids=${encodeURIComponent(commentIds.join(','))}`,
  );
  if (!res.ok) return {};
  const data = (await res.json()) as { mentions?: Record<string, CommentMentionView[]> };
  return data.mentions ?? {};
}

// @-mention one or more users on a comment (ac-1). Each newly-mentioned user is
// added to the discussion and emailed.
export async function addCommentMentions(commentId: string, userIds: string[]): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/comments/${commentId}/mentions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds }),
  });
  if (!res.ok) {
    throw new Error(`Failed to add mentions: ${res.status}`);
  }
}

// Assign a comment to a single owner (ac-2). Assignment is mention + ownership.
export async function assignComment(commentId: string, userId: string): Promise<Comment> {
  const res = await fetchWithRetry(`${tBase()}/comments/${commentId}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    throw new Error(`Failed to assign comment: ${res.status}`);
  }
  return res.json();
}

// Clear a comment's assignment (ownership only; the mention stays).
export async function unassignComment(commentId: string): Promise<Comment> {
  const res = await fetchWithRetry(`${tBase()}/comments/${commentId}/unassign`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`Failed to unassign comment: ${res.status}`);
  }
  return res.json();
}

/**
 * The 12-element typed-comment vocabulary the server validates against (per
 * Section 7 of doc-10 / t-4). t-16 only needs `'question'` (for "Flag for
 * discussion" on candidate decisions); the full set lives here for forward-
 * compatibility so future surfaces don't have to widen the helper. Source is
 * intentionally not exposed to the client — the server stamps 'human' for
 * REST and 'agent' for the agent runtime.
 */
export type CommentType =
  | 'discussion'
  | 'plan'
  | 'progress'
  | 'issue'
  | 'deferred'
  | 'cross_reference'
  | 'question'
  | 'review'
  | 'readiness_check'
  | 'approval'
  | 'plan_revision'
  | 'drift';

export interface CommentExtras {
  type?: CommentType;
}

export async function createDecisionComment(
  decisionId: string,
  authorName: string,
  content: string,
  extras?: CommentExtras,
): Promise<Comment> {
  const body: Record<string, unknown> = { authorName, content };
  if (extras?.type !== undefined) body.type = extras.type;
  const res = await fetchWithRetry(`${tBase()}/comments/decision/${decisionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to create comment: ${res.status}`);
  }
  return res.json();
}

export async function fetchTaskComments(
  taskId: string,
  type?: CommentType,
): Promise<Comment[]> {
  const url = type
    ? `${tBase()}/comments/task/${taskId}?type=${encodeURIComponent(type)}`
    : `${tBase()}/comments/task/${taskId}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch task comments: ${res.status}`);
  }
  return res.json();
}

export async function createTaskComment(
  taskId: string,
  authorName: string,
  content: string,
  extras?: CommentExtras,
): Promise<Comment> {
  const body: Record<string, unknown> = { authorName, content };
  if (extras?.type !== undefined) body.type = extras.type;
  const res = await fetchWithRetry(`${tBase()}/comments/task/${taskId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to create comment: ${res.status}`);
  }
  return res.json();
}
