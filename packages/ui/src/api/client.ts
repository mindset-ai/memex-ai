import type { DocSummary, DocSection, Comment, DocCommentsResult, Decision, Task, DocWithGraph, DocStatus, PlanReadinessEntry, Issue, IssueType, MemexIssue, Tag } from './types';
import {
  ApiError,
  NotFoundError,
  AuthApiError,
  OrgApiError,
  MemberApiError,
  ShareAccessError,
} from './errors';
import { fetchJson as fetchJsonRaw } from './fetchJson';
import { BASE_URL, fetchWithRetry, authHeaders, tenantBase } from './http';
export {
  ApiError,
  NotFoundError,
  AuthApiError,
  OrgApiError,
  MemberApiError,
  ShareAccessError,
};
export { fetchJson } from './fetchJson';
export { fetchWithRetry, authHeaders } from './http';
// spec-136: re-export the Tag wire type so call sites can pull it from the
// client alongside the tag functions below.
export type { Tag } from './types';
// spec-158: re-export the Memex-level issue wire type alongside the
// fetchMemexIssues helper the Issues page consumes.
export type { MemexIssue } from './types';

// t-18 of doc-15: tenancy-scoped surfaces have moved to
// `/api/<namespace>/<memex>/<resource>`. Helper for the call sites in this
// module — falls back to the flat `BASE_URL` when the browsing context is on
// the bare/apex domain (which means we want the std-5 single-membership
// inference or an entity-keyed UUID lookup).
function tBase(): string {
  return tenantBase() ?? BASE_URL;
}

export interface FetchDocsOptions {
  /** Comma-separated server include tokens. `'driftCount'` (t-19 W2) attaches
   *  open drift counts to Standards; `'acHealth'` (b-66 t-2) attaches the
   *  per-Spec AC-health roll-up consumed by the Specs board; `'assignees'`
   *  (spec-118) attaches the Spec's assignees; `'tags'` (spec-136 t-4) attaches
   *  each doc's tags in one batched round-trip so cards can render chips. Pass
   *  any combination; unknown tokens are ignored server-side so the union is
   *  safe to extend. */
  include?: ReadonlyArray<'driftCount' | 'acHealth' | 'assignees' | 'tags'>;
  /**
   * spec-136 t-4: tag-facet filter as `scope::value`/flat strings. Sent as
   * repeated `?tags=` params (the server also accepts CSV). The server ANDs
   * across scopes and ORs within a scope; each flat tag is its own AND clause.
   * Empty/whitespace entries are dropped client-side. Additive to `docType`.
   */
  tags?: ReadonlyArray<string>;
}

/**
 * List documents in the current memex.
 *
 * Pass an optional `docType` (e.g. `'spec'`, `'standard'`) to scope the
 * result; the server's `/api/docs?type=` query is a single-value equality
 * filter. Used by the four list pages (Specs / Standards / Documents /
 * everything) per dec-25.
 *
 * Per t-19 W2: pass `{ include: ['driftCount'] }` to receive `driftCount`
 * inline on each summary in one round-trip rather than fanning out
 * fetchDocComments calls.
 */
export async function fetchDocs(
  docType?: string,
  opts?: FetchDocsOptions,
): Promise<DocSummary[]> {
  const params = new URLSearchParams();
  if (docType) params.set('type', docType);
  if (opts?.include?.length) params.set('include', opts.include.join(','));
  // spec-136 t-4: repeated `?tags=` params (server also accepts CSV). Skip
  // empty/whitespace entries so a stray blank never trips the server's 400.
  if (opts?.tags?.length) {
    for (const t of opts.tags) {
      if (t.trim().length > 0) params.append('tags', t);
    }
  }
  const qs = params.toString();
  const url = qs ? `${tBase()}/docs?${qs}` : `${tBase()}/docs`;
  return fetchJsonRaw<DocSummary[]>(fetchWithRetry, url);
}

// ── Search (spec-64 — omnibox over GET /api/<ns>/<mx>/search) ─────────────────
// Thin typed client over the read-only search route (spec-64 t-1/t-2). The
// server projects every lane onto the same UUID-stripped public hit shape and
// returns the `{ jumpTo, assigned, content }` envelope; the omnibox (spec-64
// t-3/t-4) renders the three lanes as tiers. Public-read: the auto-attached
// session token (when present) lets a member search a private memex, while an
// anonymous request to a public memex still works (the route gates reads
// server-side, not here).

/** The user-facing entity kinds searchMemex accepts (server MemexSearchKind). */
export type SearchHitKind = 'spec' | 'standard' | 'document' | 'decision' | 'issue';

/** Which search channel surfaced a hit/section (handle | fts | semantic). */
export type SearchStrategy = string;

/** A section of a content hit that matched the query (spec-64 t-1). */
export interface SearchMatchingSection {
  id: string;
  sectionType: string;
  title: string | null;
  content: string;
  matchedVia: SearchStrategy;
}

/**
 * The public, UUID-stripped hit shape shared by all three lanes (spec-64 t-1
 * ac-7). `path` is the canonical path WITHOUT a leading slash, e.g.
 * `mindset-prod/memex-building-itself/specs/spec-34` — navigate by prefixing
 * `/`. `jumpTo`/`assigned` hits carry `matchingSections: []` (navigation rows);
 * `content` hits carry the populated body match.
 */
export interface SearchHit {
  kind: SearchHitKind;
  path: string;
  title: string;
  status: string;
  score: number;
  strategies: SearchStrategy[];
  matchingSections: SearchMatchingSection[];
  decisionSnippet?: string;
  decisionMatchedVia?: SearchStrategy;
}

/** The `{ jumpTo, assigned, content }` envelope (spec-64 t-1 ac-6). */
export interface SearchEnvelope {
  jumpTo: SearchHit[];
  assigned: SearchHit[];
  content: SearchHit[];
}

export interface SearchOptions {
  /** Scope to a single entity kind; unset searches every kind. */
  kind?: SearchHitKind;
  /** Cap the content lane (server default 8). Must be a positive integer. */
  limit?: number;
  /** Abort signal so a superseded debounced query can cancel its in-flight request. */
  signal?: AbortSignal;
}

/**
 * Search the current memex. GET /api/<ns>/<mx>/search?q=&kind=&limit= — returns
 * the `{ jumpTo, assigned, content }` envelope (spec-64 t-1/t-2). The omnibox
 * debounces `q` (~150ms) before calling this. An empty/whitespace query short-
 * circuits to an empty envelope without a round-trip (the server would 200 with
 * empty lanes anyway, but skipping the call keeps the palette quiet on open).
 */
export async function searchMemexApi(
  query: string,
  opts?: SearchOptions,
): Promise<SearchEnvelope> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { jumpTo: [], assigned: [], content: [] };
  }
  const params = new URLSearchParams({ q: trimmed });
  if (opts?.kind) params.set('kind', opts.kind);
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  return fetchJsonRaw<SearchEnvelope>(
    fetchWithRetry,
    `${tBase()}/search?${params.toString()}`,
    opts?.signal ? { signal: opts.signal } : undefined,
  );
}

// ── Tags (spec-136 t-4 REST surface) ─────────────────────────────────────────
// All three ride the existing docs router. Writes go through the server's tags
// service (create-or-pick + per-scope mutual exclusivity + change-bus emission);
// the client never constructs tag rows itself — it sends `scope::value`/flat
// strings and reads back resolved `Tag` objects.

/**
 * Fetch the whole Memex tag catalogue (every coined `{scope, value}`), ordered
 * scope-then-value. Powers the picker/filter type-ahead so the user can pick an
 * existing tag before minting a near-duplicate. GET /api/docs/tags — registered
 * before /:id on the server so the literal segment isn't swallowed.
 */
export async function fetchMemexTags(): Promise<Tag[]> {
  return fetchJsonRaw<Tag[]>(fetchWithRetry, `${tBase()}/docs/tags`);
}

/**
 * Apply one or more tags to a doc. Each entry is a `scope::value` or flat
 * string; the server resolves create-or-pick and enforces per-scope mutual
 * exclusivity (setting `priority::high` replaces any existing `priority::*`).
 * Attribution: the link's `added_by` is the session user. POST /api/docs/:id/tags.
 *
 * Returns `{ applied, tags }`: `applied` is the tags resolved from THIS call,
 * `tags` is the doc's full tag set after the writes (so the picker re-renders
 * without a follow-up GET). 400 if `tags` is not a string[].
 */
export async function setDocTags(
  docId: string,
  tags: string[],
): Promise<{ applied: Tag[]; tags: Tag[] }> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to apply tags: ${res.status}`);
  }
  return res.json();
}

/**
 * Remove a single tag's link from a doc (no-op if the doc doesn't carry it).
 * POST /api/docs/:id/tags/remove. Returns `{ tags }` — the doc's remaining tag
 * set. 400 if `tagId` is missing/empty.
 */
export async function removeDocTag(
  docId: string,
  tagId: string,
): Promise<{ tags: Tag[] }> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/tags/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tagId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to remove tag: ${res.status}`);
  }
  return res.json();
}

// ── spec-118: per-Spec roles + assignment ───────────────────────────────────

export type DocRole = 'editor' | 'reviewer';

export interface DocEditor {
  userId: string;
  name: string | null;
  email: string | null;
  role: DocRole;
}

export interface DocRoleState {
  editors: DocEditor[];
  /** The current viewer's resolved posture — drives reviewer vs editor UI mode. */
  myRole: DocRole;
}

export interface DocAssigneeView {
  userId: string;
  name: string | null;
  email: string | null;
  assignedAt: string;
}

/** The editors of a Spec + the caller's own resolved role (spec-118 t-3). */
export async function fetchDocRole(docId: string): Promise<DocRoleState> {
  return fetchJsonRaw<DocRoleState>(fetchWithRetry, `${tBase()}/doc-members/doc/${docId}`);
}

/** Promote a member to editor (self when userId omitted). Frictionless, no confirm (dec-5). */
export async function promoteToEditor(docId: string, userId?: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/doc-members/doc/${docId}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userId ? { userId } : {}),
  });
  if (!res.ok) throw new Error(`Failed to promote: ${res.status}`);
}

/** Demote a member to reviewer (self when userId omitted). No last-editor lock (dec-5). */
export async function demoteToReviewer(docId: string, userId?: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/doc-members/doc/${docId}/demote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userId ? { userId } : {}),
  });
  if (!res.ok) throw new Error(`Failed to demote: ${res.status}`);
}

/** The current assignees of a Spec (spec-118 t-4). */
export async function fetchDocAssignees(docId: string): Promise<DocAssigneeView[]> {
  return fetchJsonRaw<DocAssigneeView[]>(fetchWithRetry, `${tBase()}/doc-assignees/doc/${docId}`);
}

export async function assignUser(docId: string, userId?: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/doc-assignees/doc/${docId}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userId ? { userId } : {}),
  });
  if (!res.ok) throw new Error(`Failed to assign: ${res.status}`);
}

export async function unassignUser(docId: string, userId: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/doc-assignees/doc/${docId}/unassign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error(`Failed to unassign: ${res.status}`);
}

export async function fetchDoc(id: string): Promise<DocWithGraph> {
  return fetchJsonRaw<DocWithGraph>(fetchWithRetry, `${tBase()}/docs/${id}`, undefined, {
    errorFactory: (status) => {
      if (status === 404) return new NotFoundError(`Document not found: ${id}`);
      return new Error(`Failed to fetch document: ${status}`);
    },
  });
}

export async function updateDocStatus(docId: string, status: DocStatus): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    throw new Error(`Failed to update status: ${res.status}`);
  }
}

export async function updateDocTitle(docId: string, title: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to rename spec: ${res.status}`);
  }
}

export async function archiveDoc(docId: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/archive`, {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to archive spec: ${res.status}`);
  }
}

export async function pauseDoc(docId: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/pause`, {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to pause spec: ${res.status}`);
  }
}

export async function unpauseDoc(docId: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/unpause`, {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to unpause spec: ${res.status}`);
  }
}

// spec-178 (UI CLIENT CONTRACT): re-seed the personal Memex's Handhold demo. POSTs
// the route the ROUTE agent owns — POST /api/:namespace/:memex/handhold/reset — which
// hard-deletes the existing demo specs (+ their seeded emissions) and re-seeds the five
// frozen spec-64 copies. The namespace/memex are passed explicitly (the SpecList board's
// Reset button supplies them from the current tenant context) rather than inferred from
// the URL, so the call site is unambiguous. Owner-of-personal-namespace gate is enforced
// server-side; a non-owner / non-personal target returns 404 (std-7).
export async function resetHandholdDemo(namespace: string, memex: string): Promise<void> {
  const res = await fetchWithRetry(`${BASE_URL}/${namespace}/${memex}/handhold/reset`, {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to reset demo: ${res.status}`);
  }
}

// spec-206 t-1/t-3: the user-level first-run greeting gate (NOT tenant-scoped).
export interface GreetingGate {
  /** True iff the user has never been greeted (onboarding_greeted_at IS NULL). */
  greet: boolean;
  /** First whitespace token of users.name, or null → warm nameless fallback. */
  firstName: string | null;
}

/** Should Specky greet this user on first run? Called on board mount. */
export async function fetchGreetingGate(): Promise<GreetingGate> {
  return fetchJsonRaw<GreetingGate>(fetchWithRetry, `${BASE_URL}/onboarding/greeting`);
}

/** Stamp onboarding_greeted_at — called ONLY once the greeting actually starts
 *  speaking (dec-4 / ac-16). Idempotent server-side; never re-greets after. */
export async function stampGreeting(): Promise<void> {
  const res = await fetchWithRetry(`${BASE_URL}/onboarding/greeting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`Failed to stamp greeting: ${res.status}`);
}

export interface MoveDocInput {
  targetMemexId: string;
  includeDecisions: boolean;
  includeTasks: boolean;
  includeSectionComments: boolean;
}

export interface MoveDocResponse {
  doc: { id: string; handle: string; memexId: string; title: string };
  fromMemexId: string;
  toMemexId: string;
  newHandle: string;
  removedDecisionDeps: number;
  removedTaskDeps: number;
  revokedShareTokens: number;
}

export async function moveDocApi(docId: string, input: MoveDocInput): Promise<MoveDocResponse> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text || `Failed to move spec: ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      /* leave message as-is */
    }
    throw new Error(message);
  }
  return res.json();
}

export async function splitSection(sectionId: string): Promise<DocSection[]> {
  const res = await fetchWithRetry(`${tBase()}/docs/sections/${sectionId}/split`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`Failed to split section: ${res.status}`);
  }
  return res.json();
}

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
// can stamp a distinct audit trail — Reject → 'rejected', Resolve → 'resolved'
// (Accept stays 'accepted' via the /drift/proposals/:id/accept path). Omitting
// it POSTs an empty body, preserving the prior no-resolution behaviour.
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

// ── Decisions ──

/**
 * Look up a decision by its `dec-N` handle, scoped to the current account
 * (server resolves the account from the session). Used by t-18's
 * `<DecisionLink>` component to follow standard `[per dec-N]` references
 * to the source decision's parent spec doc.
 */
export async function fetchTaskByHandle(
  handle: string,
  parentDocId?: string,
): Promise<Task> {
  // b-42 t-2: `?docId=` scopes lookup so a memex with multiple Specs each
  // having a t-1 doesn't 409 on link clicks. Caller passes the doc id of the
  // context the link was rendered in (section / comment owner doc).
  const query = parentDocId ? `?docId=${encodeURIComponent(parentDocId)}` : "";
  return fetchJsonRaw<Task>(
    fetchWithRetry,
    `${tBase()}/tasks/by-handle/${encodeURIComponent(handle)}${query}`,
    undefined,
    {
      errorFactory: (status) => {
        if (status === 404) return new NotFoundError(`Task ${handle} not found`);
        return new Error(`Failed to fetch task ${handle}: ${status}`);
      },
    },
  );
}

/**
 * Resolve a decision handle to a Decision row.
 *
 * Accepts three forms:
 *   - bare              `dec-N`        (legacy, t-18)
 *   - doc-qualified     `doc-N:dec-M`  (legacy qualified, t-20 W-A)
 *   - Spec-qualified    `mis-N:dec-M`  (canonical, t-7 — server-side asserts
 *                                       parent is a Spec; `mis-` literal
 *                                       pre-dates the b-105 rename)
 * The colon is URL-encoded so `mis-3:dec-7` goes over the wire as
 * `mis-3%3Adec-7`.
 *
 * Errors:
 *   - 404 → `NotFoundError` (handle resolves to no decision in the account)
 *   - 409 → plain `Error` carrying the server's "ambiguous" message AND the
 *           candidate qualified handles in `.message` (so the UI can surface
 *           "ambiguous reference" without parsing JSON; future work can move
 *           the candidates into a structured field). The same path covers
 *           `mis-N:dec-M` cites whose parent isn't a Spec (t-7).
 */
export async function fetchDecisionByHandle(
  handle: string,
  parentDocId?: string,
): Promise<Decision> {
  // b-42 t-2: `?docId=` scopes lookup so a memex with multiple Specs each
  // having a dec-1 doesn't 409 on link clicks. Qualified handles (`doc-N:dec-M`,
  // `mis-N:dec-M`) ignore the query — they already encode the parent.
  const query = parentDocId ? `?docId=${encodeURIComponent(parentDocId)}` : "";
  const url = `${tBase()}/decisions/by-handle/${encodeURIComponent(handle)}${query}`;
  const res = await fetchWithRetry(url);
  if (res.ok) {
    return res.json();
  }
  if (res.status === 404) {
    throw new NotFoundError(`Decision ${handle} not found`);
  }
  if (res.status === 409) {
    // Server returns { error, code: 'AMBIGUOUS_DECISION_HANDLE', candidates: [...] }
    let body: { error?: string; candidates?: string[] } = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    const detail =
      body.candidates && body.candidates.length > 0
        ? ` Candidates: ${body.candidates.join(', ')}`
        : '';
    throw new Error(
      `${body.error ?? `Decision ${handle} is ambiguous`}${detail}`,
    );
  }
  throw new Error(`Failed to fetch decision: ${res.status}`);
}

export async function fetchDecisions(docId: string): Promise<Decision[]> {
  const res = await fetchWithRetry(`${tBase()}/decisions/doc/${docId}`);
  if (!res.ok) throw new Error(`Failed to fetch decisions: ${res.status}`);
  return res.json();
}

export async function createDecision(docId: string, title: string): Promise<Decision> {
  const res = await fetchWithRetry(`${tBase()}/decisions/doc/${docId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to create decision: ${res.status}`);
  return res.json();
}

/**
 * Resolve a decision. When the decision carries `options[]`, pass
 * `chosenOptionIndex` to record which option was selected — the server
 * persists it on the row (per t-5 / dec-8). Omit the index for free-text
 * resolutions on decisions without options.
 */
export async function resolveDecisionApi(
  id: string,
  resolution: string,
  chosenOptionIndex?: number,
): Promise<Decision> {
  const body: { resolution: string; chosenOptionIndex?: number } = { resolution };
  if (chosenOptionIndex !== undefined) body.chosenOptionIndex = chosenOptionIndex;
  const res = await fetchWithRetry(`${tBase()}/decisions/${id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to resolve decision: ${res.status}`);
  return res.json();
}

export async function reopenDecisionApi(id: string): Promise<Decision> {
  const res = await fetchWithRetry(`${tBase()}/decisions/${id}/reopen`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to reopen decision: ${res.status}`);
  return res.json();
}

/**
 * Approve a candidate decision (candidate → open). Throws if the decision is
 * not currently a candidate (server-side strict transition per t-5).
 */
export async function approveDecisionApi(id: string): Promise<Decision> {
  const res = await fetchWithRetry(`${tBase()}/decisions/${id}/approve`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to approve decision: ${res.status}`);
  return res.json();
}

/**
 * Reject a candidate decision (candidate → rejected). The reason is persisted
 * in `resolution`. Throws if the decision is not currently a candidate.
 */
export async function rejectDecisionApi(id: string, reason: string): Promise<Decision> {
  const res = await fetchWithRetry(`${tBase()}/decisions/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`Failed to reject decision: ${res.status}`);
  return res.json();
}

// ── Tasks ──

export async function fetchTasks(docId: string): Promise<Task[]> {
  const res = await fetchWithRetry(`${tBase()}/tasks/doc/${docId}`);
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
  return res.json();
}

// Batched plan readiness (one POST replaces N per-task fetches). Empty input
// short-circuits without a request — typical specs have a handful of tasks
// with linked plans, so this stays cheap. Cross-tenant ids are silently dropped
// server-side; here we just return whatever the server gives us.
export async function fetchPlanReadiness(taskIds: string[]): Promise<PlanReadinessEntry[]> {
  if (taskIds.length === 0) return [];
  const res = await fetchWithRetry(`${tBase()}/execution-plans/readiness`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds }),
  });
  if (!res.ok) throw new Error(`Failed to fetch plan readiness: ${res.status}`);
  return res.json();
}

export async function createTaskApi(
  docId: string,
  title: string,
  description: string
): Promise<Task> {
  const res = await fetchWithRetry(`${tBase()}/tasks/doc/${docId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description }),
  });
  if (!res.ok) throw new Error(`Failed to create task: ${res.status}`);
  return res.json();
}

export async function updateTaskStatusApi(
  id: string,
  status: string
): Promise<Task> {
  const res = await fetchWithRetry(`${tBase()}/tasks/${id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Failed to update task: ${res.status}`);
  return res.json();
}

export async function addBlockerApi(
  taskId: string,
  blockedBy: string
): Promise<Task> {
  const res = await fetchWithRetry(`${tBase()}/tasks/${taskId}/blockers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blockedBy }),
  });
  if (!res.ok) throw new Error(`Failed to add blocker: ${res.status}`);
  return res.json();
}

export async function removeBlockerApi(
  taskId: string,
  handle: string
): Promise<Task> {
  const res = await fetchWithRetry(`${tBase()}/tasks/${taskId}/blockers/${handle}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to remove blocker: ${res.status}`);
  return res.json();
}


// ── Issues (spec-112) ──
// Thin REST mirror of the Issues service — the same surface the MCP issue tools
// drive, one behaviour two front doors (s-4). The list endpoint is the REST
// mirror of list_issues; create / status / convert / kick mirror the matching
// MCP tools.

export async function fetchIssues(docId: string): Promise<Issue[]> {
  const res = await fetchWithRetry(`${tBase()}/issues/doc/${docId}`);
  if (!res.ok) throw new Error(`Failed to fetch issues: ${res.status}`);
  return res.json();
}

export async function createIssueApi(
  docId: string,
  title: string,
  body: string,
  type: IssueType,
  severity?: string | null,
): Promise<Issue> {
  const res = await fetchWithRetry(`${tBase()}/issues/doc/${docId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, type, severity: severity ?? null }),
  });
  if (!res.ok) throw new Error(`Failed to create issue: ${res.status}`);
  return res.json();
}

export async function updateIssueStatusApi(id: string, status: string): Promise<Issue> {
  const res = await fetchWithRetry(`${tBase()}/issues/${id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Failed to update issue: ${res.status}`);
  return res.json();
}

// Down-bridge: Issue → Task (ac-20). Returns the created Task + the spawned
// implementation AC id + the now-`converted` Issue.
export async function convertIssueToTaskApi(
  id: string,
): Promise<{ task: Task; acId: string; issue: Issue }> {
  const res = await fetchWithRetry(`${tBase()}/issues/${id}/convert-to-task`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to convert issue to task: ${res.status}`);
  return res.json();
}

// Up-bridge: Task → Issue (ac-30). Keyed on the offending agent Task id; the
// server kicks the work up into a human Todo Issue and deletes the Task.
export async function kickTaskToIssueApi(
  taskId: string,
  reason: string,
): Promise<{ issue: Issue; deletedTaskId: string; reverted: boolean }> {
  const res = await fetchWithRetry(`${tBase()}/issues/from-task/${taskId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`Failed to kick task to issue: ${res.status}`);
  return res.json();
}

// ── Memex-level Issues feed (spec-158 t-4) ──
// The read-only roll-up of every OPEN issue across the Memex, joined to its
// parent Spec — the feed the Issues page groups under each Spec heading. Mirrors
// GET /api/<ns>/<mx>/issues-list (routes/issues-list.ts). Distinct from
// fetchIssues above, which is the per-Spec list; this is the cross-Spec list.

export interface FetchMemexIssuesOptions {
  /** 'mine' (default, server-side) restricts to issues on Specs assigned to the
   *  caller; 'all' widens to the whole Memex. Sent as `?scope=`. */
  scope?: 'mine' | 'all';
  /** Subset of draft/specify/build/verify/done — narrows on the parent Spec's
   *  status. Empty/absent ⇒ all phases. Sent as a CSV `?phases=`. */
  phases?: ReadonlyArray<string>;
  /** Subset of bug/todo — narrows on the issue's type. Empty/absent ⇒ all types.
   *  Sent as a CSV `?types=`. */
  types?: ReadonlyArray<IssueType>;
}

export async function fetchMemexIssues(
  opts?: FetchMemexIssuesOptions,
): Promise<MemexIssue[]> {
  const params = new URLSearchParams();
  if (opts?.scope) params.set('scope', opts.scope);
  if (opts?.phases?.length) params.set('phases', opts.phases.join(','));
  if (opts?.types?.length) params.set('types', opts.types.join(','));
  const qs = params.toString();
  const url = qs ? `${tBase()}/issues-list?${qs}` : `${tBase()}/issues-list`;
  const body = await fetchJsonRaw<{ items: MemexIssue[] }>(fetchWithRetry, url);
  return body.items;
}

// ── Auth / SSO ──

/**
 * Per doc-15 the legacy `accounts` table split into three peer concepts:
 * a Memex (workspace), an Org (billing/membership container), and a Namespace
 * (URL slug). Server + client both speak Memex/Namespace on the wire as of
 * t-17. `kind` distinguishes a user namespace (`'personal'`) from an org
 * namespace (`'team'`).
 */
export interface MembershipSummary {
  /** The Memex id this membership grants access to. */
  memexId: string;
  /** Namespace slug — the first path segment in /<namespace>/<memex>/ URLs. */
  slug: string;
  /**
   * Memex slug — the second path segment in /<namespace>/<memex>/ URLs.
   * Added in t-18 of doc-15 so the React UI can construct the path-prefixed
   * API URLs (/api/<slug>/<memexSlug>/docs etc.) without hard-coding the
   * "personal" / "main" convention.
   */
  memexSlug: string;
  /** Org name for team rows; memex name for personal rows. */
  name: string;
  /**
   * Memex's own display name. Always populated; for personal rows it equals
   * `name`, for team rows it's the Memex's own name (so sibling Memexes in
   * the same Org display distinctly).
   */
  memexName?: string;
  kind: 'personal' | 'team';
  /** Role on the Org. Per t-11 the legacy `'user'` value is now `'member'`. */
  role: 'member' | 'administrator';
  /**
   * Access provenance (spec-111 t-6/t-8). `'org'` rows come from a personal
   * namespace or an active org membership — full read+write (std-4). `'visited'`
   * rows come from `user_memex_access` — a signed-in NON-member's pin on a
   * public Memex, read-only. The React UI uses this to render the "Visited"
   * group (🌐 + read-only badge) and to suppress edit/create controls.
   *
   * Optional for back-compat with sessions cached before spec-111 (and test
   * fixtures): absent ⇒ treat as `'org'` (full access). Read-only is opt-IN via
   * an explicit `'visited'`, never inferred from absence.
   */
  source?: 'org' | 'visited';
  /**
   * Effective access level for this row. `'write'` for org rows (std-4
   * members), `'read'` for visited public Memexes. Distinct from `role` (the
   * user's org role, meaningless for non-members). Absent ⇒ treat as `'write'`.
   */
  accessLevel?: 'read' | 'write';
  /**
   * The Memex's own visibility (spec-111 t-8). Rides on the membership row (set
   * by the server's `listMemberships`) so the global header can light the 🌐
   * public badge next to the Memex name without a second fetch. Optional for
   * back-compat with pre-spec-111 sessions / fixtures; absent ⇒ render no badge.
   */
  visibility?: 'public' | 'private';
}

export interface SessionPayload {
  user: {
    id: string;
    email: string;
    name: string | null;
    status: 'active' | 'disabled';
    emailVerified: boolean;
  };
  memberships: MembershipSummary[];
  /** The Memex the session is currently scoped to. */
  currentMemexId: string | null;
  currentRole: 'member' | 'administrator' | null;
  needsOnboarding: boolean;
  /** Server-driven feature-hide list (slugs the client should suppress). Sourced from
   *  the server's HIDDEN_FEATURES env var; fail-open ([]) when unset. */
  hiddenFeatures: string[];
  /** Fresh session token (present on signup/login/SSO/magic-link responses). Client stores
   *  as `memex-auth-token`. Absent on session refresh responses (client already has it). */
  token?: string;
}

async function authEndpoint(
  path: string,
  body: Record<string, unknown>,
  token: string | null = null,
): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AuthApiError(
      res.status,
      data.reason ?? data.error,
      data.message ?? data.error ?? `Request failed: ${res.status}`,
    );
  }
  return data;
}

export async function fetchSessionApi(token: string | null): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/me`, {
    headers: { ...authHeaders(token) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AuthApiError(
      res.status,
      body.reason ?? body.error,
      body.message ?? body.error ?? `Session refresh failed: ${res.status}`,
    );
  }
  return res.json();
}

export interface ProbeResult {
  exists: boolean;
  hasPassword: boolean;
}

export async function probeAuthApi(email: string): Promise<ProbeResult> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AuthApiError(
      res.status,
      body.reason ?? body.error,
      body.message ?? body.error ?? `Probe failed: ${res.status}`,
    );
  }
  return res.json();
}

export async function signupApi(email: string, password: string): Promise<SessionPayload> {
  return authEndpoint('/auth/signup', { email, password });
}

export async function loginApi(email: string, password: string): Promise<SessionPayload> {
  return authEndpoint('/auth/login', { email, password });
}

export async function verifyEmailApi(token: string): Promise<SessionPayload> {
  return authEndpoint('/auth/verify-email', { token });
}

export async function resendVerificationApi(token: string | null): Promise<void> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/resend-verification`, {
    method: 'POST',
    headers: { ...authHeaders(token) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AuthApiError(
      res.status,
      body.reason ?? body.error,
      body.message ?? body.error ?? `Resend failed: ${res.status}`,
    );
  }
}

export async function magicLinkRequestApi(email: string): Promise<void> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AuthApiError(
      res.status,
      body.reason ?? body.error,
      body.message ?? body.error ?? `Magic link request failed: ${res.status}`,
    );
  }
}

export async function magicLinkConsumeApi(token: string): Promise<SessionPayload> {
  return authEndpoint('/auth/magic-link/consume', { token });
}

export async function passwordResetRequestApi(email: string): Promise<void> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/password-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AuthApiError(
      res.status,
      body.reason ?? body.error,
      body.message ?? body.error ?? `Reset request failed: ${res.status}`,
    );
  }
}

export async function passwordResetConfirmApi(
  token: string,
  password: string,
): Promise<SessionPayload> {
  return authEndpoint('/auth/password-reset/confirm', { token, password });
}

export async function ssoLoginApi(idToken: string, memexId?: string): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/sso/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...(memexId ? { memexId } : {}) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `SSO login failed: ${res.status}`);
  }
  return res.json();
}

export async function updateProfileApi(
  token: string | null,
  name: string,
): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/profile`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Profile update failed: ${res.status}`);
  }
  return res.json();
}

// ── Org / Memex creation (doc-15 t-14, doc-19 t-7) ──
// POST /api/orgs creates an Org + its Namespace + an admin membership. Per dec-1
// of doc-19, Org creation no longer bundles a default Memex; the caller adds
// Memexes via the separate /api/namespaces/:id/memexes flow.

export interface OrgCreateResponse {
  org: { id: string; namespaceId: string; name: string };
  namespace: { id: string; slug: string; kind: 'user' | 'org' };
}

export type OrgSlugCheckReason = 'too_short' | 'too_long' | 'invalid_chars' | 'reserved' | 'taken';

export interface OrgSlugCheckResult {
  available: boolean;
  reason?: OrgSlugCheckReason;
}

/**
 * Live availability check for the Org-creation form. Calls GET
 * /api/namespaces/check?slug=… which validates format + checks the namespaces
 * table (and the post-rename reservation table).
 */
export async function checkNamespaceSlugApi(
  slug: string,
  token: string | null,
): Promise<OrgSlugCheckResult> {
  const res = await fetchWithRetry(
    `${BASE_URL}/namespaces/check?slug=${encodeURIComponent(slug)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`Slug check failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Create an Org. Returns the new org/namespace pair. The caller is responsible
 * for navigating to the new Org page (no Memex is created — per dec-1 of doc-19).
 *
 * Errors:
 *   - 403 / `email_not_verified` → user must verify email first
 *   - 409 / `slug_taken` → namespace slug already in use
 *   - 429 / `rate_limit_exceeded` → too many orgs created recently
 *   - 400 / `validation_error` → bad slug / name
 */
export async function createOrgApi(
  slug: string,
  token: string | null,
  name?: string,
): Promise<OrgCreateResponse> {
  const res = await fetchWithRetry(`${BASE_URL}/orgs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ slug, ...(name ? { name } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OrgApiError(
      res.status,
      body.code,
      body.code,
      body.error ?? body.message ?? `Create Org failed: ${res.status}`,
    );
  }
  return body;
}

/**
 * Rename a Namespace's slug (PATCH /api/namespaces/:id/slug). Cooldown-protected
 * on the server — surfaces as 429 / `cooldown_active` when blocked.
 */
export async function renameNamespaceSlugApi(
  namespaceId: string,
  newSlug: string,
  token: string | null,
): Promise<{ namespace: { id: string; slug: string } }> {
  const res = await fetchWithRetry(`${BASE_URL}/namespaces/${namespaceId}/slug`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ slug: newSlug }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OrgApiError(
      res.status,
      body.code,
      body.code,
      body.error ?? body.message ?? `Slug rename failed: ${res.status}`,
    );
  }
  return body;
}

// ── Namespace home + Memex creation (doc-19 t-4, t-5, t-6) ──

import type { NamespaceHomeResponse, MemexDto } from './types';
export type { NamespaceHomeResponse, MemexDto };

/**
 * Fetch the kind-aware home payload for a namespace. The response shape
 * discriminates on `kind`: 'org' has memexes + member count + role; 'personal'
 * has the single personal memex.
 *
 * Errors:
 *   - 403 → caller is not a member / owner of the namespace
 *   - 404 → namespace not found
 */
export async function getNamespaceHomeApi(
  namespaceId: string,
  token: string | null,
): Promise<NamespaceHomeResponse> {
  const res = await fetchWithRetry(`${BASE_URL}/namespaces/${namespaceId}/home`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Namespace home fetch failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Create a sibling Memex inside an existing namespace. Caller must be an active
 * org member; personal namespaces reject with 403 / `kind_not_org` per dec-3 of
 * doc-19.
 *
 * Errors:
 *   - 403 / `kind_not_org` → namespace is a user namespace (Q4-deferred)
 *   - 403 / `not_a_member` → caller is not an active org member
 *   - 409 / `slug_taken` → slug collides within this namespace
 *   - 400 / `validation_error` → bad slug format
 */
export async function createMemexApi(
  namespaceId: string,
  slug: string,
  name: string | undefined,
  token: string | null,
): Promise<{ memex: MemexDto }> {
  const res = await fetchWithRetry(`${BASE_URL}/namespaces/${namespaceId}/memexes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ slug, ...(name ? { name } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OrgApiError(
      res.status,
      body.code,
      body.code,
      body.error ?? body.message ?? `Create Memex failed: ${res.status}`,
    );
  }
  return body;
}

/**
 * Per-namespace slug availability for the Add Memex form. Returns the same
 * shape as checkNamespaceSlugApi.
 */
export async function checkMemexSlugApi(
  namespaceId: string,
  slug: string,
  token: string | null,
): Promise<OrgSlugCheckResult> {
  const res = await fetchWithRetry(
    `${BASE_URL}/namespaces/${namespaceId}/memexes/check?slug=${encodeURIComponent(slug)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`Memex slug check failed: ${res.status}`);
  }
  return res.json();
}

// ── /api/me — namespace picker (std-5 / t-11 of doc-15) ──

export interface NamespaceGroup {
  /** Namespace UUID — used by /api/namespaces/:namespaceId/* endpoints. */
  namespaceId?: string;
  namespaceSlug: string;
  kind: 'personal' | 'team';
  /** Caller's role in this namespace (administrator for personal). */
  role?: 'member' | 'administrator';
  memexes: { memexId: string; memexSlug?: string; name: string; role: 'member' | 'administrator' }[];
}

/**
 * Fetch the caller's namespaces grouped for the post-login picker. Used when the
 * session has no current Memex (e.g. user belongs to multiple orgs and we need
 * them to pick) and by an in-app namespace switcher built on top of /api/me.
 */
export async function listMyNamespacesApi(token: string | null): Promise<NamespaceGroup[]> {
  const res = await fetchWithRetry(`${BASE_URL}/me/namespaces`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`List namespaces failed: ${res.status}`);
  }
  const body = (await res.json()) as { namespaces: NamespaceGroup[] };
  return body.namespaces;
}

export interface MeSummary {
  user: { id: string; email: string; name: string | null; namespaceId: string | null };
  currentMemexId: string | null;
  currentRole: 'member' | 'administrator' | null;
}

/**
 * Minimal session shape — fast path for SPAs that only need the caller's identity
 * + current memex without the full membership list.
 */
export async function getMeApi(token: string | null): Promise<MeSummary> {
  const res = await fetchWithRetry(`${BASE_URL}/me`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Get me failed: ${res.status}`);
  }
  return res.json();
}

// ── /api/consent — domain-based auto-join consent (t-13 / std-6 of doc-15) ──
//
// On every authenticated session the React UI calls getPendingConsentApi to
// know whether to show the OrgConsentDialog. The server NEVER auto-inserts
// org_memberships from SSO callbacks; this endpoint is the single path for
// matching-domain users to be added to an org. Decisions are sticky per
// (user, org) pair on the server, so the client can fire-and-forget on close.

export interface PendingConsentOrg {
  orgId: string;
  name: string;
  slug: string;
  domain: string;
}

export interface PendingConsentResult {
  pending: PendingConsentOrg[];
  disabled: PendingConsentOrg[];
}

export type ConsentResponse = 'accepted' | 'declined' | 'skipped';

export interface ConsentDecisionInput {
  orgId: string;
  response: ConsentResponse;
}

/**
 * Fetch pending domain-match consent prompts for the current user. Returns
 * `pending` (orgs to render in the consent dialog) and `disabled` (orgs where
 * the user has a disabled membership — UI shows a "contact admin" notice).
 * Both lists are server-filtered for stickiness; UI just renders.
 */
export async function getPendingConsentApi(
  token: string | null,
): Promise<PendingConsentResult> {
  const res = await fetchWithRetry(`${BASE_URL}/consent/pending`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch pending consent: ${res.status}`);
  }
  return res.json();
}

/**
 * Submit a batch of consent decisions in one round-trip. Each decision is
 * idempotent server-side, so retrying after a partial network failure is safe.
 * The server applies them in a single transaction and returns `{ ok: true }`.
 */
export async function submitConsentDecisionsApi(
  decisions: ConsentDecisionInput[],
  token: string | null,
): Promise<void> {
  const res = await fetchWithRetry(`${BASE_URL}/consent/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ decisions }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Consent submission failed: ${res.status}`);
  }
}

// ── Org membership (invite accept) ──
// Per doc-15 the new POST /api/orgs surface (createOrgApi above) is the only
// org-creation path live in the React UI. The earlier back-compat shims
// (createAccountApi / listDiscoverableAccountsApi / joinAccountByDomainApi /
// DiscoverableAccount) had no callers post-t-17 and were removed in the
// std-1 drift sweep.

export type SubdomainCheckError = 'too_short' | 'too_long' | 'invalid_chars' | 'reserved' | 'taken';

export interface SubdomainCheckResult {
  valid: boolean;
  available: boolean;
  error?: SubdomainCheckError;
}

export async function checkSubdomainApi(
  subdomain: string,
  token: string | null,
): Promise<SubdomainCheckResult> {
  const res = await fetchWithRetry(
    `${BASE_URL}/orgs/check?slug=${encodeURIComponent(subdomain)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`Subdomain check failed: ${res.status}`);
  }
  return res.json();
}

export async function joinOrgApi(
  token: string | null,
  inviteToken?: string,
): Promise<SessionPayload> {
  const res = await fetchWithRetry(`${BASE_URL}/invites/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(inviteToken ? { token: inviteToken } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OrgApiError(
      res.status,
      body.error,
      body.reason,
      body.message ?? body.error ?? `Join failed: ${res.status}`,
    );
  }
  return body;
}

// ── Invites (admin) ──

export interface Invite {
  id: string;
  orgId: string;
  token: string;
  revokedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

// Invite mint/list/revoke moved under the tenant prefix (/api/<ns>/<mx>/invites)
// because the handlers need `ctx.currentMemexId`, which memexResolver only sets
// for path-prefixed URLs. `joinOrgApi` below still hits flat /api/invites/accept
// — that route IS the path that grants a tenant context, so it can't require one.

// Optional tenant override. When omitted, the helpers fall back to `tBase()` —
// the caller's current memex (URL path or session). Pass an explicit value to
// target a SPECIFIC org's invite list (e.g. from the Manage Orgs page, where
// the cards may belong to orgs other than the one in the user's session).
// Invites are stored at the org level (`invite_tokens.orgId`), so the memex
// segment just identifies which org via memexResolver — any memex of the
// target org works.
function invitesBase(override?: { namespaceSlug: string; memexSlug: string }): string {
  if (override) return `${BASE_URL}/${override.namespaceSlug}/${override.memexSlug}`;
  return tBase();
}

export async function createInviteApi(
  token: string | null,
  tenantOverride?: { namespaceSlug: string; memexSlug: string },
): Promise<Invite> {
  const res = await fetchWithRetry(`${invitesBase(tenantOverride)}/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Create invite failed: ${res.status}`);
  }
  return res.json();
}

export async function listInvitesApi(
  token: string | null,
  tenantOverride?: { namespaceSlug: string; memexSlug: string },
): Promise<Invite[]> {
  const res = await fetchWithRetry(`${invitesBase(tenantOverride)}/invites`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`List invites failed: ${res.status}`);
  }
  return res.json();
}

export async function revokeInviteApi(
  inviteId: string,
  token: string | null,
  tenantOverride?: { namespaceSlug: string; memexSlug: string },
): Promise<Invite> {
  const res = await fetchWithRetry(`${invitesBase(tenantOverride)}/invites/${inviteId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Revoke invite failed: ${res.status}`);
  }
  return res.json();
}

// ── Org settings (admin) ──

export interface OrgSummaryDto {
  id: string;
  name: string;
  slug: string;
  emailDomains: string[];
  autoGroupingEnabled: boolean;
  domainVerified: boolean;
  freeDomainsInUse: string[];
  verifiedDomains: Array<{ domain: string; method: 'sso' | 'email'; verifiedAt: string }>;
}

// `/orgs/current/*` (settings, members, domain verification) needs a memex
// context, so it lives under the tenant prefix. `BASE_URL` is the fallback for
// callers on the bare domain — in practice every UI page that hits these is
// inside a tenant, so tBase() returns the prefixed URL.

export async function getOrgApi(token: string | null): Promise<OrgSummaryDto> {
  const res = await fetchWithRetry(`${tBase()}/orgs/current`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`Get org failed: ${res.status}`);
  return res.json();
}

export async function updateOrgApi(
  token: string | null,
  patch: { name?: string; emailDomains?: string[]; autoGroupingEnabled?: boolean },
): Promise<OrgSummaryDto> {
  const res = await fetchWithRetry(`${tBase()}/orgs/current`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Update org failed: ${res.status}`);
  }
  return body;
}

export interface DomainVerifyInitResult {
  id: string;
  domain: string;
  expiresAt: string;
  sentTo: string[];
  sendErrors?: string[];
}

export async function initiateDomainVerificationApi(
  token: string | null,
  domain: string,
): Promise<DomainVerifyInitResult> {
  const res = await fetchWithRetry(`${tBase()}/orgs/current/domains/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ domain }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message ?? body.error ?? `Initiate verification failed: ${res.status}`);
  }
  return body;
}

// ── Org members (admin) ──

export interface OrgMemberDto {
  userId: string;
  email: string;
  role: 'member' | 'administrator';
  status: 'active' | 'disabled';
  joinedAt: string;
}

export async function listOrgMembersApi(token: string | null): Promise<OrgMemberDto[]> {
  const res = await fetchWithRetry(`${tBase()}/orgs/current/members`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`List members failed: ${res.status}`);
  return res.json();
}

export interface MemberPatchInput {
  role?: 'member' | 'administrator';
  status?: 'active' | 'disabled';
}

// Read-only member list available to any active org member (unlike listOrgMembersApi,
// which is admin-only). Returns only ACTIVE members, no status field. Powers the in-header
// Org dialog.
export interface TeamMemberDto {
  userId: string;
  email: string;
  role: 'member' | 'administrator';
  joinedAt: string;
}

export async function listTeamMembersApi(token: string | null): Promise<TeamMemberDto[]> {
  const res = await fetchWithRetry(`${tBase()}/team/members`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `List team members failed: ${res.status}`);
  }
  return res.json();
}

export async function patchOrgMemberApi(
  token: string | null,
  userId: string,
  patch: MemberPatchInput,
): Promise<OrgMemberDto> {
  const res = await fetchWithRetry(`${tBase()}/orgs/current/members/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new MemberApiError(res.status, body.code, body.error ?? `Member update failed: ${res.status}`);
  }
  return body;
}

// ── Per-Memex settings: visibility (spec-111 t-5 / t-7) ──
//
// The visibility surface lives at /api/<namespace>/<memex>/memexes/:id —
// path-prefixed because the server's per-verb middleware (publicSessionMiddleware
// on GET, strict session + adminGate on PATCH) resolves the tenant memex from the
// URL. `tBase()` produces the prefixed base when the browsing context is on a
// tenant URL (always true on a Memex settings page).

export type MemexVisibility = 'public' | 'private';

export interface MemexVisibilityDto {
  id: string;
  namespaceId: string;
  slug: string;
  name: string;
  visibility: MemexVisibility;
}

/**
 * Read a single Memex's public-facing shape (id/slug/name/visibility). Public
 * memexes are readable by anyone; private memexes 404 for non-members (std-7).
 */
export async function fetchMemexApi(
  memexId: string,
  token: string | null,
): Promise<MemexVisibilityDto> {
  const res = await fetchWithRetry(`${tBase()}/memexes/${memexId}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    if (res.status === 404) throw new NotFoundError(`Memex not found: ${memexId}`);
    throw new Error(`Failed to fetch memex: ${res.status}`);
  }
  const body = (await res.json()) as { memex: MemexVisibilityDto };
  return body.memex;
}

/**
 * Flip a Memex's visibility (public ⇄ private). Owner/admin-gated server-side
 * (adminGate); non-admins / anonymous callers get 403 / 401. The change takes
 * effect on the next read immediately.
 */
export async function updateMemexVisibilityApi(
  memexId: string,
  visibility: MemexVisibility,
  token: string | null,
): Promise<MemexVisibilityDto> {
  const res = await fetchWithRetry(`${tBase()}/memexes/${memexId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ visibility }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? body.message ?? `Update visibility failed: ${res.status}`);
  }
  return (body as { memex: MemexVisibilityDto }).memex;
}

/** The public-facing Memex shape returned by the slug-based readability probe. */
export interface PublicMemexProbe {
  id: string;
  namespaceId: string;
  slug: string;
  name: string;
  visibility: MemexVisibility;
}

/**
 * spec-111 — anonymous readability probe for a tenant Memex. Hits the slug-based
 * GET /api/<namespace>/<memex>/memexes (publicSessionMiddleware + canReadMemex):
 * 200 + the Memex when it's publicly readable, 404 when it's private/unknown to
 * an anonymous caller (std-7). TenantLayout uses the result to choose the
 * read-only public shell vs bounce-to-login for a visitor with no session, and
 * to feed the Memex name + visibility into PageHeader (an anonymous visitor has
 * no membership row to read those from). Sends NO auth header by design — it
 * answers "can an ANONYMOUS visitor read this?". Returns null on any non-2xx /
 * network error so the caller defaults to the safe (login) path.
 */
export async function probePublicMemex(
  namespace: string,
  memexSlug: string,
): Promise<PublicMemexProbe | null> {
  try {
    const res = await fetch(`${BASE_URL}/${namespace}/${memexSlug}/memexes`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { memex?: PublicMemexProbe };
    return body.memex ?? null;
  } catch {
    return null;
  }
}

// ── Share links (t-10) ──

export interface ShareTokenDto {
  id: string;
  documentId: string;
  token: string;
  revoked: boolean;
  createdAt: string;
}

export async function createShareLinkApi(
  docId: string,
  token: string | null,
): Promise<ShareTokenDto> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
  });
  if (!res.ok) {
    throw new Error(`Create share link failed: ${res.status}`);
  }
  return res.json();
}

export async function listShareLinksApi(
  docId: string,
  token: string | null,
): Promise<ShareTokenDto[]> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/shares`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`List share links failed: ${res.status}`);
  }
  return res.json();
}

export async function revokeShareLinkApi(
  shareId: string,
  token: string | null,
): Promise<ShareTokenDto> {
  const res = await fetchWithRetry(`${tBase()}/docs/shares/${shareId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Revoke share link failed: ${res.status}`);
  }
  return res.json();
}

export interface SharedCommentDto {
  id: string;
  memexId: string;
  sectionId: string | null;
  decisionId: string | null;
  taskId: string | null;
  authorName: string;
  authorUserId: string | null;
  authorNamespaceId: string | null;
  content: string;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SharedDocumentDto {
  doc: {
    id: string;
    memexId: string;
    handle: string;
    title: string;
    docType: string;
    status: string;
    createdAt: string;
    statusChangedAt: string;
  };
  sections: Array<{
    id: string;
    docId: string;
    sectionType: string;
    title: string | null;
    content: string;
    seq: number;
    createdAt: string;
    updatedAt: string;
  }>;
  namespaceSlug: string;
  memexName: string;
  comments: SharedCommentDto[];
}

// PUBLIC endpoint — no Authorization header sent.
export async function getSharedDocumentApi(shareToken: string): Promise<SharedDocumentDto> {
  const res = await fetchWithRetry(`${BASE_URL}/share/${shareToken}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason: 'unknown' | 'revoked' = body.reason === 'revoked' ? 'revoked' : 'unknown';
    throw new ShareAccessError(reason, body.error ?? `Share access failed: ${res.status}`);
  }
  return body;
}

// External comment POST (t-11). Bearer token required — the commenter must be a Memex user
// (any account works; the server records their account for "External" badge computation).
export async function postSharedCommentApi(
  shareToken: string,
  bearerToken: string | null,
  target: { kind: 'section' | 'decision' | 'task'; id: string },
  content: string,
): Promise<SharedCommentDto> {
  const res = await fetchWithRetry(`${BASE_URL}/share/${shareToken}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(bearerToken) },
    body: JSON.stringify({ target, content }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.reason === 'revoked' || body.reason === 'unknown') {
      throw new ShareAccessError(body.reason, body.error ?? 'Share access failed');
    }
    throw new Error(body.error ?? `Comment failed: ${res.status}`);
  }
  return body;
}

// ── MCP installer + tokens ──

export interface CliAuthLookupResult {
  status: 'pending' | 'completed' | 'consumed';
  expiresAt: string;
}

export async function lookupCliAuthApi(
  code: string,
  token: string | null,
): Promise<CliAuthLookupResult | null> {
  const res = await fetchWithRetry(`${BASE_URL}/cli/auth/lookup?code=${encodeURIComponent(code)}`, {
    headers: authHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Lookup failed: ${res.status}`);
  }
  return res.json();
}

export async function completeCliAuthApi(
  code: string,
  label: string,
  token: string | null,
): Promise<void> {
  const res = await fetchWithRetry(`${BASE_URL}/cli/auth/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ code, label }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Authorize failed: ${res.status}`);
  }
}

export interface McpTokenSummary {
  id: string;
  label: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export async function listMcpTokensApi(token: string | null): Promise<McpTokenSummary[]> {
  const res = await fetchWithRetry(`${BASE_URL}/mcp/tokens`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`List MCP tokens failed: ${res.status}`);
  return res.json();
}

export async function revokeMcpTokenApi(
  id: string,
  token: string | null,
): Promise<McpTokenSummary> {
  const res = await fetchWithRetry(`${BASE_URL}/mcp/tokens/${id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Revoke failed: ${res.status}`);
  }
  return res.json();
}

// ── Emission keys (spec-129) — per-Memex keys gating POST /api/test-events ──
// Memex-scoped, like fetchMemexApi: the route resolves the Memex from the tenant path, so
// these calls hit `${tBase()}/emission-keys`. The raw key is returned ONCE by generate;
// list/revoke only ever expose the non-secret prefix.

export interface EmissionKeySummary {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Generate response — carries the raw `key` exactly once (never returned again). */
export interface GeneratedEmissionKey extends EmissionKeySummary {
  key: string;
}

export async function listEmissionKeysApi(
  token: string | null,
): Promise<EmissionKeySummary[]> {
  const res = await fetchWithRetry(`${tBase()}/emission-keys`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`List emission keys failed: ${res.status}`);
  return res.json();
}

export async function generateEmissionKeyApi(
  name: string,
  token: string | null,
): Promise<GeneratedEmissionKey> {
  const res = await fetchWithRetry(`${tBase()}/emission-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      body.error ?? body.message ?? `Generate emission key failed: ${res.status}`,
    );
  }
  return body as GeneratedEmissionKey;
}

export async function revokeEmissionKeyApi(
  id: string,
  token: string | null,
): Promise<EmissionKeySummary> {
  const res = await fetchWithRetry(`${tBase()}/emission-keys/${id}/revoke`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      body.error ?? body.message ?? `Revoke emission key failed: ${res.status}`,
    );
  }
  return body as EmissionKeySummary;
}

/**
 * Drift Inbox row — open `drift` or `plan_revision` typed comment with parent
 * doc + section context attached. See packages/server/src/services/drift-inbox.ts
 * for the canonical shape.
 */
export interface DriftInboxItem {
  commentId: string;
  /** The comment's per-doc `c-N` handle (spec-143 i-2) — rendered on the row
   *  and threaded into the drift_item focus chip so the agent gets an
   *  actionable ref without a list_comments round-trip. */
  commentHandle: string;
  commentType: 'drift' | 'plan_revision';
  source: 'human' | 'agent' | null;
  authorName: string;
  content: string;
  /**
   * Normalized proposed replacement text (spec-143 dec-2 / ac-9). The server
   * guarantees this is non-null for every `plan_revision` — including proposals
   * authored without the `~~~proposed-content` fence — so the inbox always
   * renders a proposal as a before/after diff and never falls through to an
   * undifferentiated blob. `null` for a `drift` observation.
   */
  proposedContent: string | null;
  createdAt: string; // ISO timestamp from the JSON wire
  section: {
    id: string;
    sectionType: string;
    title: string | null;
    content: string;
  } | null;
  doc: {
    id: string;
    handle: string;
    title: string;
    docType: string;
    status: string;
  };
}

/**
 * Fetch the Standards Drift Inbox. Pass `{ doc: 'std-N' }` to narrow to a
 * single standard (the per-standard drift-badge deep-link → `/drift?doc=std-N`).
 */
export async function fetchDriftInbox(
  opts?: { doc?: string },
): Promise<DriftInboxItem[]> {
  const qs = opts?.doc ? `?doc=${encodeURIComponent(opts.doc)}` : '';
  const body = await fetchJsonRaw<{ items: DriftInboxItem[] }>(
    fetchWithRetry,
    `${tBase()}/drift${qs}`,
  );
  return body.items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slack integration (doc-23 T-5)
// ─────────────────────────────────────────────────────────────────────────────

export interface OrgSlackStatus {
  orgId: string | null;
  orgName: string;
  personal: boolean;
  connected: boolean;
  workspaceName?: string;
  displayName?: string;
  slackWorkspaceId?: string;
}

export async function getSlackStatusApi(token: string | null): Promise<OrgSlackStatus[]> {
  return fetchJsonRaw<OrgSlackStatus[]>(
    fetchWithRetry,
    `${BASE_URL}/auth/slack`,
    { method: 'GET', headers: authHeaders(token) },
  );
}

// ── Discord webhook settings (spec-138) ──────────────────────────────────────
// Mounted at /api/:namespace/:memex/discord-webhook — all calls use tBase().

export interface DiscordWebhookStatus {
  connected: boolean;
  channelName?: string | null;
  webhookUrlPreview?: string;
}

function discordBase(namespace: string, memex: string): string {
  return `${BASE_URL}/${namespace}/${memex}/discord-webhook`;
}

export async function getDiscordWebhookApi(
  token: string | null,
  namespace: string,
  memex: string,
): Promise<DiscordWebhookStatus> {
  return fetchJsonRaw<DiscordWebhookStatus>(
    fetchWithRetry,
    discordBase(namespace, memex),
    { method: 'GET', headers: authHeaders(token) },
  );
}

export async function saveDiscordWebhookApi(
  token: string | null,
  namespace: string,
  memex: string,
  webhookUrl: string,
  channelName?: string,
): Promise<DiscordWebhookStatus> {
  return fetchJsonRaw<DiscordWebhookStatus>(
    fetchWithRetry,
    discordBase(namespace, memex),
    {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl, channelName }),
    },
  );
}

export async function deleteDiscordWebhookApi(
  token: string | null,
  namespace: string,
  memex: string,
): Promise<void> {
  await fetchJsonRaw<{ connected: boolean }>(
    fetchWithRetry,
    discordBase(namespace, memex),
    { method: 'DELETE', headers: authHeaders(token) },
  );
}

export async function disconnectSlackApi(token: string | null, orgId: string | null): Promise<void> {
  const qs = orgId ? `?org_id=${encodeURIComponent(orgId)}` : '';
  await fetchJsonRaw<{ revoked: boolean }>(
    fetchWithRetry,
    `${BASE_URL}/auth/slack${qs}`,
    { method: 'DELETE', headers: authHeaders(token) },
  );
}

export async function consumeDomainVerificationApi(verifyToken: string): Promise<{
  domain: string;
  method: 'sso' | 'email';
  verifiedAt: string;
}> {
  // Public — no auth required (the token is the proof).
  const res = await fetchWithRetry(`${BASE_URL}/orgs/domains/verify/${verifyToken}`, {
    method: 'POST',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OrgApiError(
      res.status,
      body.error,
      body.reason,
      body.message ?? body.error ?? `Verify domain failed: ${res.status}`,
    );
  }
  return body;
}

// ─── OAuth (b-31 W1 t-5) ────────────────────────────────────────────────────
export interface OAuthAuthorizePreview {
  client_name: string;
  scopes: string[];
  /** User's grantable Orgs (per b-31 dec-8). Empty array = personal-only flow. */
  orgs: { id: string; name: string }[];
}

export interface OAuthAuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  state?: string;
}

export async function oauthAuthorizePreviewApi(
  params: OAuthAuthorizeParams,
  token: string | null,
): Promise<OAuthAuthorizePreview> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, v);
  }
  const res = await fetchWithRetry(`${BASE_URL}/oauth/authorize/preview?${qs}`, {
    headers: authHeaders(token),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error_description ?? body.error ?? `Preview failed: ${res.status}`;
    const e = new Error(msg);
    (e as Error & { status?: number }).status = res.status;
    throw e;
  }
  return body;
}

export async function oauthAuthorizeDecisionApi(
  params: OAuthAuthorizeParams,
  decision: 'allow' | 'deny',
  token: string | null,
  /** Chosen Org id (per b-31 dec-8); null for personal-only. */
  orgId: string | null,
): Promise<{ redirect: string }> {
  const res = await fetchWithRetry(`${BASE_URL}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({
      ...params,
      decision,
      // Server only inspects org_id when present; omit it for null so the
      // body shape stays clean. The auth route then treats absence as
      // "personal-only" (and 400s on user-with-orgs without it).
      ...(orgId ? { org_id: orgId } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error_description ?? body.error ?? `Authorize failed: ${res.status}`);
  }
  return body;
}

// ══════════════════════════════════════════════════════════════════════
// Acceptance Criteria — verification view + alignment history
// ══════════════════════════════════════════════════════════════════════
// Server-side derivation; UI consumes the denormalised payloads.
// See packages/server/src/services/acs.ts for the source of truth on the
// shape, the verification-state derivation, and the staleness threshold.

export type AcKind = 'scope' | 'implementation';
export type AcStatus = 'proposed' | 'active' | 'rejected' | 'superseded';
// spec-188 dec-1: 'accepted' is the audited human override for ACs that can't
// be exercised by a digital test — own visual identity, counts toward the
// verified percentage.
export type AcVerificationState =
  | 'verified'
  | 'failing'
  | 'untested'
  | 'stale'
  | 'accepted';

export interface AcTestSnapshot {
  testIdentifier: string | null;
  latestStatus: 'pass' | 'fail' | 'error';
  /** ISO string from JSON; convert at the call site if you need Date. */
  latestRunAt: string;
  runCount: number;
}

export interface AcWithVerification {
  ac: {
    id: string;
    memexId: string;
    briefId: string;
    seq: number;
    kind: AcKind;
    statement: string;
    status: AcStatus;
    /** spec-188: manual-acceptance provenance — display snapshot of who
     *  accepted (user.name ?? email). Null when not accepted. */
    acceptedBy: string | null;
    /** ISO timestamp of the acceptance; null when not accepted. Note the
     *  acceptance is an overlay — verificationState may read 'failing' while
     *  these stay set (evidence wins, dec-2). */
    acceptedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  canonicalRef: string;
  tests: AcTestSnapshot[];
  verificationState: AcVerificationState;
  daysSinceLastRun: number | null;
  /** Polymorphic parent links — used by the Decisions tab strip to filter
   *  ACs whose parents include a given decisionId. Empty array means the AC
   *  has no recorded parent. */
  // Wire-format discriminator: the server sends the DB `parent_kind` value,
  // which stays 'brief' (see services/acs.ts ParentKind). Not the product noun.
  parents: Array<{ kind: 'brief' | 'decision'; id: string }>;
}

export interface AcAlignmentDay {
  date: string;
  kind: AcKind;
  verified: number;
  total: number;
}

export async function fetchAcsForBrief(
  docId: string,
): Promise<AcWithVerification[]> {
  const res = await fetchWithRetry(`${tBase()}/acs/doc/${docId}`);
  if (!res.ok) throw new Error(`Failed to fetch ACs: ${res.status}`);
  return res.json();
}

// spec-188: manual verification acceptance — POST records, DELETE revokes.
// Server derives the actor from the session; no body needed.
export async function acceptAc(acId: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/acs/${acId}/acceptance`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to accept AC: ${res.status}`);
}

export async function unacceptAc(acId: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/acs/${acId}/acceptance`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to un-accept AC: ${res.status}`);
}

export async function fetchAcAlignmentHistory(
  docId: string,
  days = 30,
): Promise<AcAlignmentDay[]> {
  const res = await fetchWithRetry(
    `${tBase()}/acs/doc/${docId}/alignment-history?days=${days}`,
  );
  if (!res.ok)
    throw new Error(`Failed to fetch AC alignment history: ${res.status}`);
  return res.json();
}

// ── b-96: per-AC test-event matrix ─────────────────────────────────────────

export type TestEventStatus = 'pass' | 'fail' | 'error';

export interface TestMatrixEmission {
  status: TestEventStatus;
  /** ISO timestamp emitted by the server. */
  emittedAt: string;
  /**
   * Actor — WHO ran the test (spec-115 dec-6, spec-122 activity contract).
   * Top-level sibling of metadata. Null when the emission did not include
   * actor.
   */
  actor?: string | null;
  /**
   * Extensible metadata bag (spec-115 v0.1.0). Surfaced in the AC matrix
   * tooltip on hover. Null/undefined when the emitting test did not pass
   * metadata (the common case for pre-v0.1.0 emissions).
   */
  metadata?: Record<string, string> | null;
}

export interface AcTestMatrixRow {
  /** test_identifier as emitted by the helper; empty string when the
   *  source row had a NULL test_identifier (legacy / hand-rolled emit). */
  testIdentifier: string;
  /** Every emission ever recorded for this (acUid, testIdentifier),
   *  newest-first. Per b-96 dec-11: one entry per emission, no run-batching. */
  emissions: TestMatrixEmission[];
}

export async function fetchAcTestMatrix(
  acId: string,
): Promise<AcTestMatrixRow[]> {
  const res = await fetchWithRetry(`${tBase()}/acs/${acId}/test-matrix`);
  if (!res.ok) throw new Error(`Failed to fetch AC test matrix: ${res.status}`);
  return res.json();
}

/**
 * Discontinue every emission for `(acId, testIdentifier)`. Hard-delete; per
 * b-96 dec-14 no audit record is written. Returns the number of rows removed.
 */
export async function discontinueAcTestEvents(
  acId: string,
  testIdentifier: string,
): Promise<{ deleted: number }> {
  const url = `${tBase()}/acs/${acId}/test-events?test_identifier=${encodeURIComponent(testIdentifier)}`;
  const res = await fetchWithRetry(url, { method: 'DELETE' });
  if (!res.ok)
    throw new Error(`Failed to discontinue test events: ${res.status}`);
  return res.json();
}

// ── Spec analytics (spec-179 — the Insights page) ─────────────────────────────
// Thin typed clients over the read-only /analytics/* aggregates. Shapes mirror
// packages/server/src/services/analytics.ts + standards-graph.ts exactly.

export interface SpecsOverTimePoint {
  day: string;
  created: number;
  cumulative: number;
}

export interface SpecsByPhasePoint {
  day: string;
  draft: number;
  specify: number;
  build: number;
  verify: number;
  done: number;
}

export interface InPhaseDuration {
  phase: 'draft' | 'specify' | 'build' | 'verify' | 'done';
  n: number;
  avgDays: number;
  medianDays: number;
  maxDays: number;
}

export interface CycleTimeStats {
  n: number;
  avgDays: number | null;
  medianDays: number | null;
  p25Days: number | null;
  p75Days: number | null;
  maxDays: number | null;
  valuesDays: number[];
}

export interface PhaseDurations {
  inPhase: InPhaseDuration[];
  cycleTime: CycleTimeStats;
}

export async function fetchSpecsOverTime(): Promise<SpecsOverTimePoint[]> {
  const { points } = await fetchJsonRaw<{ points: SpecsOverTimePoint[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/specs-over-time`,
  );
  return points;
}

export async function fetchSpecsByPhase(): Promise<SpecsByPhasePoint[]> {
  const { points } = await fetchJsonRaw<{ points: SpecsByPhasePoint[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/specs-by-phase`,
  );
  return points;
}

export async function fetchPhaseDurations(): Promise<PhaseDurations> {
  return fetchJsonRaw<PhaseDurations>(fetchWithRetry, `${tBase()}/analytics/phase-durations`);
}

export interface StandardsGraphNode {
  docId: string;
  handle: string;
  title: string;
  clauseCount: number;
}

export interface StandardsGraphMentionEdge {
  sourceDocId: string;
  targetDocId: string;
  count: number;
  evidence: Array<{ clauseSeq: number | null; snippet: string | null }>;
}

export interface StandardsGraphSemanticEdge {
  sourceDocId: string;
  targetDocId: string;
  similarity: number;
}

export interface StandardsGraphData {
  nodes: StandardsGraphNode[];
  mentionEdges: StandardsGraphMentionEdge[];
  semanticEdges: StandardsGraphSemanticEdge[];
}

export async function fetchStandardsGraph(): Promise<StandardsGraphData> {
  return fetchJsonRaw<StandardsGraphData>(fetchWithRetry, `${tBase()}/analytics/standards-graph`);
}

export interface FunnelStage {
  phase: 'draft' | 'specify' | 'build' | 'verify' | 'done';
  count: number;
}

export async function fetchPipelineFunnel(): Promise<FunnelStage[]> {
  const { stages } = await fetchJsonRaw<{ stages: FunnelStage[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/pipeline-funnel`,
  );
  return stages;
}

export interface ActivityByActorPoint {
  day: string;
  human: number;
  mcp_agent: number;
  in_app_agent: number;
}

export async function fetchActivityByActor(): Promise<ActivityByActorPoint[]> {
  const { points } = await fetchJsonRaw<{ points: ActivityByActorPoint[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/activity-by-actor`,
  );
  return points;
}

export interface AcVerificationSummary {
  total: number;
  verified: number;
  failing: number;
  untested: number;
}

export async function fetchAcVerification(): Promise<AcVerificationSummary> {
  return fetchJsonRaw<AcVerificationSummary>(fetchWithRetry, `${tBase()}/analytics/ac-verification`);
}

export interface AcsOverTimePoint {
  day: string;
  created: number;
  verified: number;
}

export async function fetchAcsOverTime(): Promise<AcsOverTimePoint[]> {
  const { points } = await fetchJsonRaw<{ points: AcsOverTimePoint[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/acs-over-time`,
  );
  return points;
}

export interface TestRunVolumePoint {
  day: string;
  pass: number;
  fail: number;
  error: number;
}

export async function fetchTestRunVolume(): Promise<TestRunVolumePoint[]> {
  const { points } = await fetchJsonRaw<{ points: TestRunVolumePoint[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/test-run-volume`,
  );
  return points;
}
