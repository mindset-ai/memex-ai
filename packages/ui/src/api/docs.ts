// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import type { DocSummary, DocSection, DocWithGraph, DocStatus, Tag } from './types';
import { NotFoundError } from './errors';
import { fetchJson as fetchJsonRaw } from './fetchJson';
import { BASE_URL, fetchWithRetry } from './http';
import { tBase } from './internal';

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

// spec-293 dec-2/dec-3: a move is always whole — no per-artifact opt-out flags.
export interface MoveDocInput {
  targetMemexId: string;
}

export interface MoveDocResponse {
  docId: string;
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
