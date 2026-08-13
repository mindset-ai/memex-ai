// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import type {
  DocSummary,
  DocSection,
  DocWithGraph,
  DocStatus,
  Tag,
  Decision,
  Task,
  Issue,
  Comment,
} from './types';
import type { AcWithVerification } from './acs';
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities';
import { NotFoundError } from './errors';
import { fetchJson as fetchJsonRaw } from './fetchJson';
import { fetchWithRetry } from './http';
import { tBase } from './internal';

export interface FetchDocsOptions {
  /** Comma-separated server include tokens. `'driftCount'` (t-19 W2) attaches
   *  open drift counts to Standards; `'acHealth'` (b-66 t-2) attaches the
   *  per-Spec AC-health roll-up consumed by the Specs board; `'assignees'`
   *  (spec-118) attaches the Spec's assignees; `'tags'` (spec-136 t-4) attaches
   *  each doc's tags in one batched round-trip so cards can render chips. Pass
   *  any combination; unknown tokens are ignored server-side so the union is
   *  safe to extend. */
  include?: ReadonlyArray<
    | 'driftCount'
    | 'acHealth'
    | 'assignees'
    | 'tags'
    | 'taskProgress'
    | 'lastActivity'
  >;
  /**
   * spec-529: resolve exactly these doc handles, in ONE request. This is how a
   * document view answers every `spec-N` its body mentions without a fetch per
   * reference. The server caps the set and drops malformed entries, so a body is
   * safe to hand straight through.
   */
  handles?: ReadonlyArray<string>;
  /**
   * spec-529: include archived docs. The reference resolver MUST set this. A
   * reference to an archived Spec is exactly the case the card's banner exists
   * for, and without this the server filters those rows out, the handle resolves
   * as absent, and the reference renders as plain text — telling the reader
   * nothing about the fact that what they are pointed at has been archived.
   */
  includeArchived?: boolean;
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
  if (opts?.includeArchived) params.set('includeArchived', 'true');
  // spec-529: repeated `?handles=` params (the server also accepts CSV).
  if (opts?.handles?.length) {
    for (const h of opts.handles) {
      if (h.trim().length > 0) params.append('handles', h);
    }
  }
  if (opts?.tags?.length) {
    for (const t of opts.tags) {
      if (t.trim().length > 0) params.append('tags', t);
    }
  }
  const qs = params.toString();
  const url = qs ? `${tBase()}/docs?${qs}` : `${tBase()}/docs`;
  const docs = await fetchJsonRaw<DocSummary[]>(fetchWithRetry, url);
  // spec-484 t-1: decode-on-read for every title-bearing field a summary carries —
  // its own title plus the promoted-from `parent` projection ("Promoted from <title>").
  return docs.map(decodeDocSummary);
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

/** A catalogue tag plus how many Specs currently carry it (spec-418 t-5). Mirrors
 *  the server's TagWithCount — the extra field the Manage-tags surface needs. */
export interface TagWithCount extends Tag {
  assignedCount: number;
}

/**
 * Fetch the whole Memex tag catalogue WITH each tag's assigned-Spec count, in one
 * aggregate round-trip. Feeds the Manage-tags admin surface (spec-418 t-5). GET
 * /api/docs/tags/with-counts — registered as a literal before /:id on the server
 * (like GET /tags) so the segment isn't swallowed by the param matcher.
 */
export async function fetchMemexTagsWithCounts(): Promise<TagWithCount[]> {
  return fetchJsonRaw<TagWithCount[]>(fetchWithRetry, `${tBase()}/docs/tags/with-counts`);
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

// ── Tag catalogue curation (spec-418 t-6 CLIENT) ─────────────────────────────
// The write-side siblings of fetchMemexTagsWithCounts, driving the Manage-tags
// dialogs. Each hits a curation route on the docs router (t-3): create (POST
// /tags), rename (PATCH /tags/:tagId), delete (DELETE /tags/:tagId). All three
// resolve the same tags service as REST + MCP, so a block surfaces the SAME
// plain reason (dec-3). On a non-2xx the server returns `{ error: <reason> }`
// (error-handler.ts) — we extract that reason and throw it verbatim so the
// dialog can show the block inline and disable its confirm.

/** A tag as `scope::value`/flat string, or the already-split structured form.
 *  Both are accepted by the curation routes (parseCurationTagBody). */
export type TagInput = string | { scope: string | null; value: string };

function tagBody(input: TagInput): string {
  return JSON.stringify(
    typeof input === 'string' ? { tag: input } : { scope: input.scope, value: input.value },
  );
}

/** Pull the server's plain-reason message off a non-2xx curation response. The
 *  curation routes answer `{ error: <human message> }`; fall back to the raw
 *  body, then to a status-coded default, so the UI always has something to show. */
async function tagErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    return parsed.error || parsed.message || text;
  } catch {
    return text;
  }
}

/**
 * Mint a NEW catalogue tag (spec-418 dec-7). POST /api/docs/tags. Returns the
 * created `Tag`. Blocked ONLY by the duplicate-name guard (case-insensitive,
 * dec-8/ac-29) — a brand-new tag is on no Spec, so the per-scope exclusivity
 * block can never apply. On a duplicate (or any non-2xx) throws an Error whose
 * message is the server's plain reason (`A tag named "…" already exists`).
 */
export async function createCatalogueTag(input: TagInput): Promise<Tag> {
  const res = await fetchWithRetry(`${tBase()}/docs/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: tagBody(input),
  });
  if (!res.ok) {
    throw new Error(await tagErrorMessage(res, `Failed to create tag: ${res.status}`));
  }
  return res.json();
}

/**
 * Rename a catalogue tag's scope/value (spec-418). PATCH /api/docs/tags/:tagId.
 * The new name is reflected on EVERY Spec carrying it. Returns the updated `Tag`.
 * A blocked rename — duplicate (case-insensitive) OR scope-exclusivity — throws
 * an Error carrying the server's plain reason, with NO change made (dec-3).
 */
export async function renameCatalogueTag(tagId: string, input: TagInput): Promise<Tag> {
  const res = await fetchWithRetry(`${tBase()}/docs/tags/${tagId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: tagBody(input),
  });
  if (!res.ok) {
    throw new Error(await tagErrorMessage(res, `Failed to rename tag: ${res.status}`));
  }
  return res.json();
}

/** The blast radius a delete removed — the tag was unlinked from `affectedDocIds`. */
export interface DeletedTagResult {
  removed: number;
  affectedDocIds: string[];
}

/**
 * Delete a catalogue tag (spec-418). DELETE /api/docs/tags/:tagId. The FK cascade
 * unlinks it from every Spec; the Specs themselves are untouched. Never blocks.
 * Returns the blast radius `{ removed, affectedDocIds }` so the caller can name
 * the post-delete confirmation ("Deleted '…' from N Specs", ac-36).
 */
export async function deleteCatalogueTag(tagId: string): Promise<DeletedTagResult> {
  const res = await fetchWithRetry(`${tBase()}/docs/tags/${tagId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(await tagErrorMessage(res, `Failed to delete tag: ${res.status}`));
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

// Decode HTML-entity-encoded plain-text TITLES on the fetched graph. Some legacy
// section-creation paths persisted titles encoded (e.g. "Architecture &amp; Security"),
// and titles render as plain React text — so the entity would show literally. Body
// `content` is markdown and is deliberately NOT touched (ReactMarkdown decodes entities
// itself; re-decoding could corrupt an intentional entity inside a code span). Idempotent
// for already-clean titles (a bare "&" without a trailing ";" is left untouched).
function decodeTitle<T extends { title?: string | null }>(x: T): T {
  return x.title ? { ...x, title: decodeHtmlEntities(x.title) } : x;
}

// spec-484 t-1: the shared decode-on-read normalizer for a board summary. Decodes the
// summary's own title AND its promoted-from `parent` projection (both title-bearing),
// reusing the same `decodeTitle` primitive as fetchDoc/splitSection so there is one
// decode path, not per-call-site copies. Content/body fields are never touched.
function decodeDocSummary(doc: DocSummary): DocSummary {
  const decoded = decodeTitle(doc);
  return doc.parent ? { ...decoded, parent: decodeTitle(doc.parent) } : decoded;
}

function normalizeDocTitles(doc: DocWithGraph): DocWithGraph {
  return {
    ...doc,
    title: decodeHtmlEntities(doc.title),
    sections: doc.sections.map(decodeTitle),
    decisions: doc.decisions.map(decodeTitle),
    tasks: doc.tasks.map(decodeTitle),
  };
}

export async function fetchDoc(id: string): Promise<DocWithGraph> {
  const doc = await fetchJsonRaw<DocWithGraph>(fetchWithRetry, `${tBase()}/docs/${id}`, undefined, {
    errorFactory: (status) => {
      if (status === 404) return new NotFoundError(`Document not found: ${id}`);
      return new Error(`Failed to fetch document: ${status}`);
    },
  });
  return normalizeDocTitles(doc);
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

// spec-521 (ac-4): archiving now carries a REASON. Optional on the wire so an older
// client cannot 400, but the dialog always sends one — it is the load-bearing column
// in the archive view, and without it archive is a black hole.
export async function archiveDoc(docId: string, reason?: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to archive spec: ${res.status}`);
  }
}

// spec-521 (ac-4, ac-5): the way back. Archiving was one-way before this, which is
// why it went unused — nobody archives on suspicion if they cannot undo it. Restore
// returns the Spec to exactly the phase it had, because archivedAt is orthogonal to
// status and archiving never moved it.
//
// ac-16: this is the ONLY caller-facing path that clears archivedAt, and it is
// web-only. No MCP tool and no in-app-agent tool reaches it.
export async function restoreDoc(docId: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/restore`, {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to restore spec: ${res.status}`);
  }
}

// spec-521 (ac-5): the archive view's data source — archived Specs only, each with
// when/by whom/why. Uses the existing includeArchived projection rather than a new
// endpoint; the caller filters to the archived ones.
export async function fetchArchivedDocs(): Promise<DocSummary[]> {
  const res = await fetchWithRetry(`${tBase()}/docs?includeArchived=true`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to load archived specs: ${res.status}`);
  }
  const all = (await res.json()) as DocSummary[];
  return all.filter((d) => d.archivedAt);
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
  // spec-484 t-1: decode-on-read the returned section titles, same as fetchDoc's graph.
  const sections = (await res.json()) as DocSection[];
  return sections.map(decodeTitle);
}

// ── Document versioning (spec-448 t-6 REST surface) ─────────────────────────
// Thin client for services/versioning.ts (t-2/t-3/t-4) via routes/versions.ts.
// GET /docs/:id (fetchDoc above) is UNCHANGED by this surface — it keeps
// resolving to the live primary with no version specified (ac-3); these calls
// are strictly additive, reached only from the create-version dialog / version
// switcher (t-8/t-9).

/** The five artifact classes a version cut can choose to carry forward
 *  (narrative sections always carry and are never a member of this set). */
export const CARRY_FORWARD_CLASSES = ['decisions', 'acs', 'tasks', 'issues', 'comments'] as const;
export type CarryForwardClass = (typeof CARRY_FORWARD_CLASSES)[number];

export interface CreateVersionInput {
  name: string;
  carryForward: CarryForwardClass[];
}

/** A snapshot's task entry is the raw stored row — it carries none of
 *  `Task`'s live-computed blocking fields (those come from the doc's
 *  blocking graph at read time, not from the frozen snapshot). */
export type VersionSnapshotTask = Omit<Task, 'blocked' | 'blockedByDecisions' | 'blockedByTasks'>;

/** The full artifact graph one version snapshot captures — mirrors the
 *  server's `ArtifactSnapshot` (services/versioning.ts). */
export interface ArtifactVersionSnapshot {
  sections: DocSection[];
  decisions: Decision[];
  acs: AcWithVerification['ac'][];
  tasks: VersionSnapshotTask[];
  issues: Issue[];
  /** Each comment carries the doc's `version` that was active when it was
   *  originally written (ac-24) — lets "view as-of vK" render vK's comments
   *  correctly even though comments have no dedicated version column. */
  comments: Array<Comment & { versionAtWrite: number }>;
}

/** One row from `document_versions` — an immutable cut (ac-1, ac-2) or a
 *  rollback's restore cut (`restoredFromVersion` set, ac-22). */
export interface DocumentVersionRow {
  id: string;
  memexId: string;
  docId: string;
  versionNumber: number;
  name: string;
  checksum: string;
  snapshot: ArtifactVersionSnapshot;
  restoredFromVersion: number | null;
  actorUserId: string | null;
  actorName: string | null;
  channel: string | null;
  createdAt: string;
}

/** Lightweight projection for the version-history list/switcher — omits the
 *  (potentially large) snapshot payload. */
export interface VersionSummary {
  versionNumber: number;
  name: string;
  createdAt: string;
  actorName: string | null;
  restoredFromVersion: number | null;
}

/** One side of a diff request: a concrete cut version, or the live primary
 *  (ac-26 — the version switcher can compare ANY two versions, including the
 *  doc's current working state). */
export type SnapshotToken = number | 'primary';

export interface VersionOrPrimarySnapshot {
  version: SnapshotToken;
  /** null for the live "primary" side — it has no `document_versions` row of
   *  its own until it's next cut. */
  name: string | null;
  createdAt: string | null;
  restoredFromVersion: number | null;
  checksum: string;
  snapshot: ArtifactVersionSnapshot;
}

export interface VersionDiffData {
  from: VersionOrPrimarySnapshot;
  to: VersionOrPrimarySnapshot;
}

/** Cut a new version of a Spec (or any doc type, ac-34). Returns the newly
 *  created `document_versions` row. POST /api/.../versions/doc/:docId. */
export async function createVersion(
  docId: string,
  input: CreateVersionInput,
): Promise<DocumentVersionRow> {
  const res = await fetchWithRetry(`${tBase()}/versions/doc/${docId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to create version: ${res.status}`);
  }
  return res.json();
}

/** List every cut version of a doc, newest first — the version-switcher /
 *  history surface. GET /api/.../versions/doc/:docId. */
export async function listVersions(docId: string): Promise<VersionSummary[]> {
  return fetchJsonRaw<VersionSummary[]>(fetchWithRetry, `${tBase()}/versions/doc/${docId}`);
}

/** View a specific frozen version as-of that cut (ac-4, ac-18, ac-25).
 *  GET /api/.../versions/doc/:docId/:versionNumber. */
export async function getVersionAsOf(
  docId: string,
  versionNumber: number,
): Promise<DocumentVersionRow> {
  return fetchJsonRaw<DocumentVersionRow>(
    fetchWithRetry,
    `${tBase()}/versions/doc/${docId}/${versionNumber}`,
    undefined,
    {
      errorFactory: (status) => {
        if (status === 404) {
          return new NotFoundError(`Version ${versionNumber} not found for document ${docId}`);
        }
        return new Error(`Failed to fetch version: ${status}`);
      },
    },
  );
}

/** Roll back the doc's live content to a prior version's snapshot. Auto-
 *  freezes the pre-rollback state first (ac-20) and returns the newly
 *  materialised `document_versions` row (`restoredFromVersion` set, ac-22).
 *  POST /api/.../versions/doc/:docId/rollback. */
export async function rollbackVersion(
  docId: string,
  sourceVersion: number,
): Promise<DocumentVersionRow> {
  const res = await fetchWithRetry(`${tBase()}/versions/doc/${docId}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceVersion }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to roll back: ${res.status}`);
  }
  return res.json();
}

/** The two snapshots to diff (ac-6, ac-26) — either side may be a concrete
 *  version number or `'primary'` (the live current state).
 *  GET /api/.../versions/doc/:docId/diff?from=&to=. */
export async function getVersionDiffData(
  docId: string,
  from: SnapshotToken,
  to: SnapshotToken,
): Promise<VersionDiffData> {
  const params = new URLSearchParams({ from: String(from), to: String(to) });
  return fetchJsonRaw<VersionDiffData>(
    fetchWithRetry,
    `${tBase()}/versions/doc/${docId}/diff?${params.toString()}`,
  );
}
