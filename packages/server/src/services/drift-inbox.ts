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

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { standardClauses } from "../db/schema.js";
import { parseProposedChangeBody } from "./standards.js";

/**
 * One clause operation of a proposal, as the Drift Inbox row renders it (spec-530 t-7).
 *
 * `before` is the target clause's body AS THE PROPOSAL WAS AUTHORED — the staleness
 * evidence dec-3's guard compares against. `current` is what the clause says RIGHT NOW.
 * Both travel because they answer different questions: `after` vs `current` is the diff a
 * reviewer judges, while `before` vs `current` is whether the proposal still applies.
 *
 * Deliberately NO derived "is stale" verdict here. dec-3 put that judgement inside the
 * accept transaction, and dec-4 gave it exactly one home; a second copy on a read model
 * that can go out of date before the user acts would be the duplication dec-4's rationale
 * exists to prevent. The row shows both bodies and lets the difference speak.
 */
export interface DriftProposalOperation {
  op: "edit" | "delete" | "add";
  /** The target's `cl-N` handle. For `add`, the ANCHOR it sits relative to. */
  clause: string;
  /** `add` only — which side of the anchor the new clause goes. */
  placement?: "before" | "after";
  /** The target's body at authoring time. Absent for `add` (nothing was there). */
  before?: string;
  /** The proposed text. Absent for `delete` (nothing replaces it). */
  after?: string;
  /** The clause's live body now, or null when it no longer exists (deleted since). */
  current: string | null;
}

/**
 * What a `plan_revision` row's body turned out to be.
 *
 * `legacy` is a pre-spec-530 whole-section replacement: readable, but not applyable by
 * the clause-grained accept path. `unreadable` is a body that parses as neither — a
 * proposal authored outside `proposeStandardChange`, or a corrupted payload. Both
 * degrade to an explanatory row rather than throwing: one unusable row is the acceptable
 * cost, a broken Inbox for every other item on the page is not (spec-530 ac-18).
 */
export type DriftProposal =
  | { kind: "clause-ops"; operations: DriftProposalOperation[] }
  | { kind: "legacy"; proposed: string }
  | { kind: "unreadable" };

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
   * Proposed replacement text for a `plan_revision` row. Non-null for every
   * `plan_revision`, null for a `drift` observation.
   *
   * spec-530 t-7 CORRECTION: this field's original contract — "normalized proposed
   * replacement text, so the UI renders a before/after diff" (spec-143 dec-2 / ac-9) —
   * only ever made sense when a proposal WAS one replacement body. At the clause grain
   * a proposal is a SET of operations and has no single "proposed body", so for a
   * clause-ops row this carries the raw comment content (which holds the operations
   * payload) rather than a synthesised rendering. **The UI renders `proposal`, not this
   * field.** It stays non-null because the drift agent's context reads it, and after
   * dec-4 the agent no longer needs to reproduce proposal text verbatim — it explains
   * the proposal and calls the accept verb by ref, for which the payload suffices.
   *
   * Kept rather than removed, and its docstring corrected rather than left describing a
   * contract it stopped honouring — which is the exact defect class this Spec is named
   * after.
   */
  proposedContent: string | null;
  /**
   * The proposal's operations, resolved against the live clauses (spec-530 t-7). This
   * is what the Inbox row renders. `null` for a `drift` observation.
   */
  proposal: DriftProposal | null;
  createdAt: Date;
  /**
   * The source DECISION a `drift` finding contradicts (spec-498 dec-4): a drift
   * comment carries `drift_decision_id` — the resolved decision whose intent the
   * repo has diverged from. Surfaced so the inbox can read the finding as a
   * relationship ("dec-N contradicts std-M") instead of a raw comment body.
   * `null` when the drift isn't linked to a decision (legacy rows) or for a
   * `plan_revision` proposal.
   */
  decision: {
    handle: string;
    title: string;
    /**
     * The owning SPEC's handle (`spec-N`), so the client can build the canonical
     * decision URL `/specs/:specHandle/decisions/:decHandle` (there is no decision
     * route without a spec). `null` when the decision isn't owned by a spec (an
     * edge case — decisions normally live on specs) → the UI degrades to a
     * non-linked handle.
     */
    specHandle: string | null;
  } | null;
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
  // Only the LEGACY shape yields a single replacement text. A clause-grained proposal is
  // a set of operations and has no one "proposed body", so it falls through to the raw
  // content — which is what the agent reads, and which carries the operations payload.
  // Deliberately no synthesised rendering: inventing one would put text on a screen that
  // nobody proposed. The structured `proposal` field below is what the UI renders
  // (spec-530 t-7); see the field docstring for why this one survives.
  if (parsed?.kind === "legacy" && parsed.proposed.trim().length > 0) {
    return parsed.proposed;
  }
  return content;
}

/**
 * Resolve every proposal on the page against the live clauses, in ONE query.
 *
 * `cl-N` is per-STANDARD (seq is allocated MAX+1 per doc), so a handle only identifies a
 * clause together with its docId — matching on seq alone would collide across two
 * Standards in the same Memex and show the wrong rule text. The lookup is therefore an
 * OR of per-doc `seq IN (…)` groups.
 *
 * Batched deliberately [per std-39]: the natural shape is a lookup inside the operation
 * loop, which would be one query per clause per row — 50 proposals of 3 operations each
 * would be 150 round-trips on a page render.
 */
async function resolveProposals(
  memexId: string,
  rows: { docId: string; commentType: "drift" | "plan_revision"; content: string }[],
): Promise<Map<string, DriftProposal | null>> {
  const out = new Map<string, DriftProposal | null>();
  const parsedByKey = new Map<string, ReturnType<typeof parseProposedChangeBody>>();
  const seqsByDoc = new Map<string, Set<number>>();

  rows.forEach((r, i) => {
    if (r.commentType !== "plan_revision") return;
    const parsed = parseProposedChangeBody(r.content);
    parsedByKey.set(String(i), parsed);
    if (parsed?.kind !== "clause-ops") return;
    for (const op of parsed.operations) {
      const handle = op.op === "add" ? op.anchor : op.clause;
      const seq = Number.parseInt(handle.replace(/^cl-/, ""), 10);
      if (!Number.isInteger(seq)) continue;
      const set = seqsByDoc.get(r.docId) ?? new Set<number>();
      set.add(seq);
      seqsByDoc.set(r.docId, set);
    }
  });

  // doc → seq → live body, for every clause any proposal on this page targets.
  const bodies = new Map<string, string>();
  if (seqsByDoc.size > 0) {
    const groups = [...seqsByDoc.entries()].map(([docId, seqs]) =>
      and(eq(standardClauses.docId, docId), inArray(standardClauses.seq, [...seqs])),
    );
    const clauseRows = await db
      .select({
        docId: standardClauses.docId,
        seq: standardClauses.seq,
        body: standardClauses.body,
      })
      .from(standardClauses)
      .where(
        and(
          eq(standardClauses.memexId, memexId),
          ne(standardClauses.status, "deleted"),
          groups.length === 1 ? groups[0] : or(...groups),
        ),
      );
    for (const c of clauseRows) bodies.set(`${c.docId}|${c.seq}`, c.body);
  }

  rows.forEach((r, i) => {
    if (r.commentType !== "plan_revision") {
      out.set(String(i), null);
      return;
    }
    const parsed = parsedByKey.get(String(i));
    if (!parsed) {
      out.set(String(i), { kind: "unreadable" });
      return;
    }
    if (parsed.kind === "legacy") {
      out.set(String(i), { kind: "legacy", proposed: parsed.proposed });
      return;
    }
    const operations: DriftProposalOperation[] = parsed.operations.map((op) => {
      const handle = op.op === "add" ? op.anchor : op.clause;
      const seq = Number.parseInt(handle.replace(/^cl-/, ""), 10);
      const current = Number.isInteger(seq)
        ? (bodies.get(`${r.docId}|${seq}`) ?? null)
        : null;
      if (op.op === "add") {
        return { op: "add", clause: op.anchor, placement: op.placement, after: op.body, current };
      }
      if (op.op === "edit") {
        return { op: "edit", clause: op.clause, before: op.before, after: op.after, current };
      }
      return { op: "delete", clause: op.clause, before: op.before, current };
    });
    out.set(String(i), { kind: "clause-ops", operations });
  });

  return out;
}

interface RawRow {
  comment_id: string;
  comment_seq: number;
  comment_type: "drift" | "plan_revision";
  source: "human" | "agent" | null;
  author_name: string;
  content: string;
  created_at: Date;
  decision_seq: number | null;
  decision_title: string | null;
  decision_spec_handle: string | null;
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
      dec.seq           AS decision_seq,
      dec.title         AS decision_title,
      dec_spec.handle   AS decision_spec_handle,
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
    LEFT JOIN decisions dec ON dec.id = c.drift_decision_id
    -- The decision's owning SPEC (for the canonical /specs/:h/decisions/:h URL).
    -- Gated to doc_type='spec' so a decision on a non-spec doc degrades to no-link.
    LEFT JOIN documents dec_spec ON dec_spec.id = dec.doc_id AND dec_spec.doc_type = 'spec'
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

  // One extra query for the whole page, not one per operation [per std-39].
  const proposals = await resolveProposals(
    memexId,
    pageRows.map((r) => ({
      docId: r.doc_id,
      commentType: r.comment_type,
      content: r.content,
    })),
  );

  const items: DriftInboxRow[] = pageRows.map((r, i) => ({
    commentId: r.comment_id,
    // The `(doc_id, seq)` allocator mints per-doc `c-N` handles (schema.ts);
    // derive the canonical form here so every consumer gets the same string.
    commentHandle: `c-${r.comment_seq}`,
    commentType: r.comment_type,
    source: r.source,
    authorName: r.author_name,
    content: r.content,
    proposedContent: normalizeProposedContent(r.comment_type, r.content),
    proposal: proposals.get(String(i)) ?? null,
    // Raw SQL via db.execute returns timestamptz as ISO string; DriftInboxRow.createdAt
    // is typed as Date for callers, so coerce here.
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    // dec-N handle derived from the per-doc seq (same convention as commentHandle).
    decision:
      r.decision_seq != null
        ? {
            handle: `dec-${r.decision_seq}`,
            title: r.decision_title ?? "",
            specHandle: r.decision_spec_handle ?? null,
          }
        : null,
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
