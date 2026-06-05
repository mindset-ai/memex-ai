// Drift Inbox (t-10 of doc-8).
//
// Returns every OPEN typed comment whose type is `drift` or `plan_revision`
// on a Standard, joined with enough parent-doc and section context that the
// React UI can render the inbox in one round-trip.
//
// Why drift + plan_revision (and nothing else):
//   - `drift` is the "code reality has diverged from this rule" flag (Section 7
//     of doc-10). It's the headline signal the inbox surfaces.
//   - `plan_revision` is the "agent thinks this rule needs rewording" proposal
//     (t-8). Same actor surface (the human standard owner) reviews both, so
//     they belong on the same page.
// Other typed comments (discussion / progress / readiness_check / etc.) are
// authored on a specific doc and read in-context — they don't need a global
// inbox view.
//
// Scoped to Standards only (b-63): drift is a standards-only concept. The write
// path (flagDrift / proposeStandardChange in services/standards.ts) already
// rejects non-standard sections, so this read-side filter (`d.doc_type =
// 'standard'`) is belt-and-braces — it keeps the inbox honest even if a stray
// drift / plan_revision comment is ever forced onto another docType. Every row
// returned is therefore anchored to a Standard. An optional `docHandle` narrows
// the inbox to a single standard (the per-standard drift-badge deep-link).
//
// Pagination: cursor on `(created_at, id)` descending. The id tiebreaker keeps
// pagination stable when several comments share a millisecond-precision
// created_at (idempotent drift scans can produce bursts). Migration 0033 adds a
// supporting index on `(account_id, created_at DESC) WHERE resolved_at IS NULL
// AND comment_type IN ('drift', 'plan_revision')` so the query stays O(limit)
// regardless of total comment count.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { parseProposedChangeBody } from "./standards.js";

export interface DriftInboxRow {
  commentId: string;
  /**
   * The comment's per-doc `c-N` handle (spec-143 i-2). Surfaced so the inbox
   * rows are referenceable by handle — the user and the drift agent discuss an
   * item as "c-2 on std-1", not "the second one", and the agent can act on the
   * ref without a list_comments recovery round-trip.
   */
  commentHandle: string;
  commentType: "drift" | "plan_revision";
  source: "human" | "agent" | null;
  authorName: string;
  content: string;
  /**
   * Normalized proposed replacement text for a `plan_revision` row (spec-143
   * dec-2 / ac-9). ALWAYS non-null for a `plan_revision` so the React UI can
   * render a before/after diff without re-parsing the fence — and so a proposal
   * authored without the `~~~proposed-content` fence (older rows, or proposals
   * written outside `proposeStandardChange`) still carries applyable text
   * instead of falling through to an undifferentiated markdown blob. `null` for
   * a `drift` observation, which is a finding with no proposed edit.
   */
  proposedContent: string | null;
  createdAt: Date;
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

export interface ListDriftInboxOptions {
  /** Maximum rows to return. Default 50, hard-capped at 200. */
  limit?: number;
  /**
   * Cursor for the next page. Pass the `nextCursor` returned by the previous
   * call. Encodes `(created_at, comment_id)` so pagination is stable under bursts
   * of comments with identical created_at.
   */
  cursor?: string | null;
  /**
   * Narrow the inbox to a single Standard by its `std-N` handle. Unknown or
   * out-of-memex handles simply match nothing (empty page) — no existence leak
   * (std-7). Used by the per-standard drift-badge deep-link (`/drift?doc=std-N`).
   */
  docHandle?: string | null;
}

export interface DriftInboxPage {
  items: DriftInboxRow[];
  /** When non-null, more rows exist — pass this back as `cursor`. */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Normalize a `plan_revision` comment body to its applyable proposed text
 * (spec-143 dec-2 / ac-9). The canonical proposal shape carries a
 * `~~~proposed-content` fence (see `buildProposedChangeBody` in standards.ts);
 * `parseProposedChangeBody` is the canonical parser for it. When a proposal was
 * authored WITHOUT the fence (older rows, or written outside
 * `proposeStandardChange`) the parser returns null — rather than letting the
 * row fall through to an undifferentiated blob in the UI, we fall back to the
 * full comment body as the proposed text. Either way a `plan_revision` ALWAYS
 * yields non-empty applyable text, so every proposal renders as a before/after
 * diff. Returns null only for non-`plan_revision` rows.
 */
function normalizeProposedContent(
  commentType: "drift" | "plan_revision",
  content: string,
): string | null {
  if (commentType !== "plan_revision") return null;
  const parsed = parseProposedChangeBody(content);
  if (parsed && parsed.proposed.trim().length > 0) return parsed.proposed;
  // Unfenced proposal: surface the raw body so the row still renders a diff
  // rather than falling through to a blob.
  return content;
}

interface RawRow {
  comment_id: string;
  comment_seq: number;
  comment_type: "drift" | "plan_revision";
  source: "human" | "agent" | null;
  author_name: string;
  content: string;
  created_at: Date;
  section_id: string | null;
  section_type: string | null;
  section_title: string | null;
  section_content: string | null;
  doc_id: string;
  doc_handle: string;
  doc_title: string;
  doc_type: string;
  doc_status: string;
}

function encodeCursor(createdAt: Date | string, commentId: string): string {
  // base64url so it's URL-safe and opaque to clients (encourages treating it as
  // a token rather than a structured value). postgres-js returns timestamptz as
  // a Date for typed Drizzle queries but as an ISO-format string for raw
  // db.execute(sql`...`) — accept either.
  const iso =
    createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  return Buffer.from(`${iso}|${commentId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; commentId: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const sepIdx = decoded.lastIndexOf("|");
    if (sepIdx === -1) return null;
    const ts = decoded.slice(0, sepIdx);
    const commentId = decoded.slice(sepIdx + 1);
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return null;
    return { createdAt: date, commentId };
  } catch {
    return null;
  }
}

export async function listDriftInbox(
  memexId: string,
  opts: ListDriftInboxOptions = {},
): Promise<DriftInboxPage> {
  const requestedLimit = opts.limit ?? DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requestedLimit)));

  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

  // Resolve the parent doc through whichever target column the comment uses
  // (section_id → doc_sections.doc_id; decision_id → decisions.doc_id;
  // task_id → tasks.doc_id). COALESCE picks the first non-null. The
  // inbox cares about the doc-level location, not which target type the
  // comment was anchored to.
  //
  // We fetch `limit + 1` so we can tell if a next page exists without a count
  // query; the extra row, if present, is dropped from the response and used to
  // mint `nextCursor`.
  // Pass the cursor timestamp as an ISO string with an explicit timestamptz cast so
  // postgres-js doesn't try to bind the Date through its parameter encoder (which
  // chokes on the Bind step here for reasons specific to this SQL shape).
  const cursorClause = cursor
    ? sql`AND (c.created_at, c.id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.commentId})`
    : sql``;

  // Optional single-standard filter (the drift-badge deep-link). The handle
  // column carries the full prefixed form (`std-N`); equality is enough and an
  // unknown handle yields no rows — empty page, no existence leak (std-7).
  const docFilter = opts.docHandle
    ? sql`AND d.handle = ${opts.docHandle}`
    : sql``;

  const rows = (await db.execute(sql`
    SELECT
      c.id              AS comment_id,
      c.seq             AS comment_seq,
      c.comment_type    AS comment_type,
      c.source          AS source,
      c.author_name     AS author_name,
      c.content         AS content,
      c.created_at      AS created_at,
      s.id              AS section_id,
      s.section_type    AS section_type,
      s.title           AS section_title,
      s.content         AS section_content,
      d.id              AS doc_id,
      d.handle          AS doc_handle,
      d.title           AS doc_title,
      d.doc_type        AS doc_type,
      d.status          AS doc_status
    FROM doc_comments c
    LEFT JOIN doc_sections s ON s.id = c.section_id
    INNER JOIN documents d ON d.id = COALESCE(
      s.doc_id,
      (SELECT doc_id FROM decisions WHERE id = c.decision_id),
      (SELECT doc_id FROM tasks WHERE id = c.task_id)
    )
    WHERE c.memex_id = ${memexId}
      AND c.resolved_at IS NULL
      AND c.comment_type IN ('drift', 'plan_revision')
      AND d.doc_type = 'standard'
      AND d.archived_at IS NULL
      ${docFilter}
      ${cursorClause}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${limit + 1}
  `)) as unknown as RawRow[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.comment_id) : null;

  const items: DriftInboxRow[] = pageRows.map((r) => ({
    commentId: r.comment_id,
    // The `(doc_id, seq)` allocator mints per-doc `c-N` handles (schema.ts);
    // derive the canonical form here so every consumer gets the same string.
    commentHandle: `c-${r.comment_seq}`,
    commentType: r.comment_type,
    source: r.source,
    authorName: r.author_name,
    content: r.content,
    proposedContent: normalizeProposedContent(r.comment_type, r.content),
    // Raw SQL via db.execute returns timestamptz as ISO string; DriftInboxRow.createdAt
    // is typed as Date for callers, so coerce here.
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    section: r.section_id
      ? {
          id: r.section_id,
          sectionType: r.section_type ?? "",
          title: r.section_title,
          content: r.section_content ?? "",
        }
      : null,
    doc: {
      id: r.doc_id,
      handle: r.doc_handle,
      title: r.doc_title,
      docType: r.doc_type,
      status: r.doc_status,
    },
  }));

  return { items, nextCursor };
}
