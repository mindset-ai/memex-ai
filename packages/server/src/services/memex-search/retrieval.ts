// Retrieval concern (spec-363 sol-7: god-module split). All DB access for
// memex-search: the FTS + vector SQL arms (sections / decisions / issues), the
// handle direct-lookup, the slug load, and the open-comment summary load. Plus
// the kind→docType scope config and the vector-distance relevance floor, since
// they parameterise the queries here. No ranking, no formatting — this layer
// returns raw rows / hits for the orchestration + ranking layers to merge and
// render. Moved verbatim from memex-search.ts.

import { sql } from "drizzle-orm";
import { db } from "../../db/connection.js";
import type { ResolvedQueryVector } from "./query-vector.js";
import { buildDocPath, kindForDocType } from "./refs.js";
import { toIso, toMillis } from "./time.js";
import type {
  DecisionRow,
  HandleRow,
  IssueRow,
  MemexSearchHit,
  MemexSearchKind,
  MemexSlugs,
  SectionRow,
} from "./types.js";

// Relevance floor for the semantic (vector) arms (spec-64 i-1). pgvector's
// `<=>` is cosine distance in [0, 2] — 0 = identical, ~1 = orthogonal /
// unrelated, 2 = opposite. The vector arms order by distance and LIMIT, but
// without a ceiling they return their nearest neighbours HOWEVER far away, so a
// low-signal query (e.g. a person's name with no lexical match) surfaces
// unrelated sections that don't contain the query terms at all. Any vector hit
// at or beyond this distance is treated as "not actually related" and dropped.
//
// Only the vector arm is floored — FTS hits require a lexeme match (`@@`) so
// they're inherently relevant, and a doc that also matched FTS still surfaces
// via that arm even if its vector row is filtered. The RRF merge is unchanged.
//
// The right value is embedding-model-specific (this default is tuned for
// openai-text-embedding-3-large @1536, the prod provider). It is overridable
// per-env via MEMEX_SEARCH_MAX_VECTOR_DISTANCE (and per-call via
// SearchMemexOptions.maxVectorDistance) so it can be tuned on INT without a
// code change before prod.
const DEFAULT_MAX_VECTOR_DISTANCE = 0.65;

// PER-ARM FETCH DEPTH — why every arm below still says `LIMIT 50`, and why that
// is a recorded decision rather than an oversight (spec-522 dec-5, item 3).
//
// Six arms x 50 rows, with full `s.content` on the section arms, are fetched and
// ranked to render a default of 8 hits. That is real payload and it was in scope
// to reduce. It was NOT reduced, because the depth cannot be lowered without
// risking ac-3 (result parity), and parity could not be demonstrated at a lower
// depth on representative data in the session that made this change:
//
//   * RRF fuses ACROSS arms, so a hit's final position depends on its rank in
//     every arm that surfaced it, not just the best one. Truncating an arm does
//     not merely drop its tail — it silently removes that arm's contribution for
//     any hit ranked below the cut, which can REORDER hits that still appear.
//   * With RRF_K = 60 the contributions across this range are close together
//     (rank 1 = 1/61 ≈ 0.0164, rank 25 = 1/85 ≈ 0.0118, rank 50 = 1/111 ≈
//     0.0090), so a dropped contribution is comparable in size to the gaps
//     between adjacent results. Ties and near-ties are exactly where it bites.
//   * The available test corpora are far smaller than 50 rows per arm, so a
//     parity test over them would pass at ANY depth and prove nothing.
//
// Lowering this is still worth doing; it needs a parity harness over a
// production-scale corpus (compare the merged top-N at depth 50 vs the candidate
// depth across a broad query set), which is a piece of work in its own right.
// Registered as a follow-up rather than guessed at here.

export function resolveMaxVectorDistance(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const env = process.env.MEMEX_SEARCH_MAX_VECTOR_DISTANCE;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_VECTOR_DISTANCE;
}

// Maps the user-facing kind enum onto the underlying docType column values.
// `'document'` is the broad "free-form" bucket (per CLAUDE.md the `documents`
// table covers all docTypes; the kind enum is a narrower user-facing
// vocabulary). 'execution_plan' is omitted from kind=document since Spec
// users probably don't want execution-plan sections in search results — they
// can still be added as a separate kind later if demand surfaces.
const DOC_TYPES_BY_KIND: Record<Exclude<MemexSearchKind, "decision" | "issue">, string[]> = {
  spec: ["spec"],
  standard: ["standard"],
  document: ["document", "adr", "runbook"],
};

// All section docTypes in scope when `kind` is omitted (decisions are handled
// by the separate decision arm).
const ALL_SECTION_DOC_TYPES = [
  ...DOC_TYPES_BY_KIND.spec,
  ...DOC_TYPES_BY_KIND.standard,
  ...DOC_TYPES_BY_KIND.document,
];

export function inScopeDocTypes(kind: MemexSearchKind | undefined): string[] | null {
  if (!kind) return ALL_SECTION_DOC_TYPES;
  // decision + issue are non-section kinds — their own arms run instead, so the
  // section query short-circuits to nothing.
  if (kind === "decision" || kind === "issue") return null;
  return DOC_TYPES_BY_KIND[kind];
}

export async function loadMemexSlugs(memexId: string): Promise<MemexSlugs | null> {
  const rows = (await db.execute(sql`
    SELECT n.slug AS namespace_slug, m.slug AS memex_slug
    FROM memexes m
    INNER JOIN namespaces n ON n.id = m.namespace_id
    WHERE m.id = ${memexId}
    LIMIT 1
  `)) as unknown as MemexSlugs[];
  return rows[0] ?? null;
}

// spec-259 ac-12: batch-load the open (unresolved) comment count + oldest open
// comment timestamp for a set of doc ids, in ONE grouped query (no N+1). Keyed
// by doc_id — a comment transitively belongs to a doc via its section/decision/
// task target, but doc_id is denormalised on the row (schema comment), so we
// group on it directly. `resolved_at IS NULL` is the open predicate. Returns a
// Map doc_id → { count, oldestCreatedAt(ISO) }; absent keys have zero open
// comments. No comment CONTENT is selected — indicator only.
interface OpenCommentRow {
  doc_id: string;
  open_count: number | string;
  oldest_created_at: string | Date;
}

async function loadOpenCommentSummaries(
  docIds: string[],
): Promise<Map<string, { count: number; oldestCreatedAt: string }>> {
  const summaries = new Map<string, { count: number; oldestCreatedAt: string }>();
  if (docIds.length === 0) return summaries;
  // De-dupe the id set (decision/section hits can share a parent doc) so the
  // IN-list is minimal.
  const uniqueIds = Array.from(new Set(docIds));
  const idList = sql.join(
    uniqueIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT
      doc_id                AS doc_id,
      COUNT(*)              AS open_count,
      MIN(created_at)       AS oldest_created_at
    FROM doc_comments
    WHERE doc_id IN (${idList})
      AND resolved_at IS NULL
    GROUP BY doc_id
  `)) as unknown as OpenCommentRow[];
  for (const r of rows) {
    const count = Number(r.open_count);
    const oldestCreatedAt = toIso(r.oldest_created_at);
    if (count > 0 && oldestCreatedAt) {
      summaries.set(r.doc_id, { count, oldestCreatedAt });
    }
  }
  return summaries;
}

// spec-259 ac-12: attach the open-comment indicator to each hit by its parent
// doc. Mutates in place and returns the same array. A decision/section hit
// inherits its parent doc's open-comment summary (the indicator is doc-scoped).
export async function attachOpenComments(hits: MemexSearchHit[]): Promise<MemexSearchHit[]> {
  if (hits.length === 0) return hits;
  const summaries = await loadOpenCommentSummaries(hits.map((h) => h.parentDocId));
  for (const hit of hits) {
    const summary = summaries.get(hit.parentDocId);
    if (summary) hit.openComments = summary;
  }
  return hits;
}

// ── Direct lookup ──────────────────────────────────────

export async function lookupByHandle(
  memexId: string,
  slugs: MemexSlugs,
  query: string,
  includeArchived: boolean,
): Promise<MemexSearchHit | null> {
  const archivedClause = includeArchived ? sql`` : sql`AND d.archived_at IS NULL`;
  const rows = (await db.execute(sql`
    SELECT
      s.id            AS section_id,
      s.section_type  AS section_type,
      s.title         AS section_title,
      s.content       AS section_content,
      s.actor_name    AS section_actor_name,
      s.updated_at    AS section_updated_at,
      s.doc_id        AS doc_id,
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.status        AS doc_status,
      d.doc_type      AS doc_type,
      d.created_at        AS doc_created_at,
      d.status_changed_at AS doc_status_changed_at,
      du.name         AS doc_author_name,
      du.email        AS doc_author_email
    FROM documents d
    LEFT JOIN doc_sections s ON s.doc_id = d.id
    LEFT JOIN users du ON du.id = d.created_by_user_id
    WHERE d.memex_id = ${memexId}
      ${archivedClause}
      AND d.is_demo IS NOT TRUE
      AND d.handle = ${query.toLowerCase()}
    ORDER BY s.seq
  `)) as unknown as HandleRow[];

  if (rows.length === 0) return null;

  const first = rows[0];

  // WHO/WHEN for a handle hit (spec-285): the heading is the DOCUMENT, so
  // attribute it from the most-recently-updated section (denormalised
  // actor_name, std-32), falling back to the doc's resolved creator. WHEN is the
  // latest section's updated_at, else the doc's own status_changed_at/created_at.
  const sections = rows.filter((r) => r.section_id != null);
  let latest: HandleRow | null = null;
  for (const r of sections) {
    if (!latest || toMillis(r.section_updated_at) > toMillis(latest.section_updated_at)) {
      latest = r;
    }
  }
  const docAuthorFallback =
    first.doc_author_name?.trim() || first.doc_author_email?.trim() || null;
  const sectionActor = latest?.section_actor_name?.trim() || null;
  const authorName = sectionActor ?? docAuthorFallback;
  const lastUpdatedAt =
    toIso(latest?.section_updated_at) ??
    toIso(first.doc_status_changed_at) ??
    toIso(first.doc_created_at);

  return {
    id: first.doc_id,
    parentDocId: first.doc_id,
    kind: kindForDocType(first.doc_type),
    path: buildDocPath(slugs, first.doc_type, first.doc_handle),
    title: first.doc_title,
    status: first.doc_status,
    score: 1,
    strategies: ["handle"],
    authorName,
    lastUpdatedAt,
    // spec-521 ac-9: the handle short-circuit IS a search_memex path, so its hit
    // carries recency like any other. A doc's content age is last-updated, which is
    // exactly the timestamp resolved above.
    recencyAt: lastUpdatedAt,
    recencyVerb: "updated" as const,
    matchingSections: sections.map((r) => ({
      id: r.section_id,
      sectionType: r.section_type,
      title: r.section_title,
      content: r.section_content,
      matchedVia: "handle",
      // spec-259 ac-9: per-section WHO/WHEN. The handle row has no resolved
      // creator fallback per-section, so use the section's denormalised
      // actor_name (std-32), else the doc-level resolved creator fallback.
      authorName: r.section_actor_name?.trim() || docAuthorFallback,
      lastUpdatedAt: toIso(r.section_updated_at),
    })),
  };
}

// ── Section FTS ────────────────────────────────────────

export async function runSectionFts(
  memexId: string,
  query: string,
  docTypes: string[],
  includeArchived: boolean,
  excludeDocId?: string,
): Promise<SectionRow[]> {
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL`;
  const excludeClause = excludeDocId
    ? sql`AND d.id <> ${excludeDocId}::uuid`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT
      s.id            AS section_id,
      s.section_type  AS section_type,
      s.title         AS section_title,
      s.content       AS section_content,
      s.doc_id        AS doc_id,
      s.updated_at    AS updated_at,
      COALESCE(NULLIF(TRIM(s.actor_name), ''), NULLIF(TRIM(du.name), ''), du.email) AS author_name,
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.status        AS doc_status,
      d.doc_type      AS doc_type,
      ts_rank(s.content_tsv, plainto_tsquery('english', ${query})) AS rank
    FROM doc_sections s
    INNER JOIN documents d ON d.id = s.doc_id
    LEFT JOIN users du ON du.id = d.created_by_user_id
    WHERE d.memex_id = ${memexId}
      AND d.doc_type IN ${sql.raw(`(${docTypes.map((t) => `'${t}'`).join(",")})`)}
      ${archivedClause}
      AND d.is_demo IS NOT TRUE
      ${excludeClause}
      AND (s.status <> 'deleted' OR s.status IS NULL)
      AND s.content_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT 50
  `)) as unknown as SectionRow[];
  return rows;
}

// ── Section Vector ─────────────────────────────────────

export async function runSectionVector(
  memexId: string,
  docTypes: string[],
  includeArchived: boolean,
  queryVec: ResolvedQueryVector,
  maxDistance: number,
  excludeDocId?: string,
): Promise<SectionRow[]> {
  // spec-522 dec-1: this arm no longer embeds. It receives an already-resolved
  // vector so ONE embed serves all three vector arms instead of three identical
  // round-trips per search. `query` is gone from the signature because the arm
  // has no remaining use for the raw string — keeping it would invite someone to
  // re-add an embed call here.
  const literal = `[${queryVec.vector.join(",")}]`;
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL`;
  const excludeClause = excludeDocId
    ? sql`AND d.id <> ${excludeDocId}::uuid`
    : sql``;

  const rows = (await db.execute(sql`
    SELECT
      s.id            AS section_id,
      s.section_type  AS section_type,
      s.title         AS section_title,
      s.content       AS section_content,
      s.doc_id        AS doc_id,
      s.updated_at    AS updated_at,
      COALESCE(NULLIF(TRIM(s.actor_name), ''), NULLIF(TRIM(du.name), ''), du.email) AS author_name,
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.status        AS doc_status,
      d.doc_type      AS doc_type,
      (s.embedding <=> ${literal}::vector) AS distance
    FROM doc_sections s
    INNER JOIN documents d ON d.id = s.doc_id
    LEFT JOIN users du ON du.id = d.created_by_user_id
    WHERE d.memex_id = ${memexId}
      AND d.doc_type IN ${sql.raw(`(${docTypes.map((t) => `'${t}'`).join(",")})`)}
      ${archivedClause}
      AND d.is_demo IS NOT TRUE
      ${excludeClause}
      AND (s.status <> 'deleted' OR s.status IS NULL)
      AND s.embedding IS NOT NULL
      AND s.embedding_model = ${queryVec.model}
      AND (s.embedding <=> ${literal}::vector) < ${maxDistance}
    ORDER BY s.embedding <=> ${literal}::vector
    LIMIT 50
  `)) as unknown as SectionRow[];
  return rows;
}

// ── Decision FTS ───────────────────────────────────────
// Index-served via `decisions.content_tsv` — a STORED generated column over
// title + context + resolution, with a GIN index (migration 0132, spec-522 t-1).
//
// This arm used to build `to_tsvector(...)` inline, per row and TWICE (once in
// the WHERE predicate, once inside ts_rank), across every decision in the Memex
// on every keystroke burst — and the comment here claimed the cost was "modest
// because the table is small relative to doc_sections". It was not: measured at
// ~390 ms per ⌘K search against live prod, which made this single arm the
// critical path of the entire search (spec-522 s-2). A query matching ZERO rows
// still paid it. Read the column; never reintroduce an inline to_tsvector here.

// spec-521 dec-5 (ac-7) — attach the supersession pointer to an already-capped hit
// set, in ONE query.
//
// Sibling of `attachOpenComments` and deliberately built the same way: enrich AFTER
// the merge, batched over the result docs. Selecting the pointer inside all seven
// retrieval tiers would have meant seven edits and seven chances for one tier to be
// missed — and a marker absent from one read path is the failure mode this Spec
// exists to fix, so the single post-merge seat is the safer shape as well as the
// cheaper one.
//
// Keys off `parentDocId`, which is the hit's own doc for spec/standard/document hits
// and the parent Spec for decision and issue hits — so a decision hit inherits its
// Spec's supersession, which is what the reader needs.
export async function attachSupersession(
  hits: MemexSearchHit[],
): Promise<MemexSearchHit[]> {
  if (hits.length === 0) return hits;
  const docIds = [...new Set(hits.map((h) => h.parentDocId))];
  const rows = (await db.execute(sql`
    SELECT d.id AS doc_id, succ.handle AS successor_handle
    FROM documents d
    INNER JOIN documents succ ON succ.id = d.superseded_by_doc_id
    WHERE d.id = ANY(${sql.raw(`ARRAY['${docIds.join("','")}']::uuid[]`)})
  `)) as unknown as { doc_id: string; successor_handle: string }[];
  if (rows.length === 0) return hits;
  const byDoc = new Map([...rows].map((r) => [r.doc_id, r.successor_handle]));
  return hits.map((h) => {
    const successor = byDoc.get(h.parentDocId);
    return successor ? { ...h, supersededByHandle: successor } : h;
  });
}

export async function runDecisionFts(
  memexId: string,
  query: string,
  includeArchived: boolean,
  excludeDocId?: string,
): Promise<DecisionRow[]> {
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL`;
  const excludeClause = excludeDocId
    ? sql`AND dec.doc_id <> ${excludeDocId}::uuid`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT
      dec.id          AS decision_id,
      dec.doc_id      AS doc_id,
      dec.seq         AS dec_seq,
      dec.title       AS dec_title,
      dec.context     AS dec_context,
      dec.resolution  AS dec_resolution,
      dec.status      AS dec_status,
      dec.created_at  AS created_at,
      dec.resolved_at AS resolved_at,
      COALESCE(NULLIF(TRIM(dec.actor_name), ''), NULLIF(TRIM(au.name), ''), au.email) AS author_name,
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.doc_type      AS doc_type,
      ts_rank(dec.content_tsv, plainto_tsquery('english', ${query})) AS rank
    FROM decisions dec
    INNER JOIN documents d ON d.id = dec.doc_id
    LEFT JOIN users au ON au.id = dec.actor_user_id
    WHERE dec.memex_id = ${memexId}
      ${archivedClause}
      AND d.is_demo IS NOT TRUE
      ${excludeClause}
      AND dec.content_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT 50
  `)) as unknown as DecisionRow[];
  return rows;
}

// ── Decision Vector ────────────────────────────────────

export async function runDecisionVector(
  memexId: string,
  includeArchived: boolean,
  queryVec: ResolvedQueryVector,
  maxDistance: number,
  excludeDocId?: string,
): Promise<DecisionRow[]> {
  // spec-522 dec-1 — see runSectionVector: the embed happens once, upstream.
  const literal = `[${queryVec.vector.join(",")}]`;
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL`;
  const excludeClause = excludeDocId
    ? sql`AND dec.doc_id <> ${excludeDocId}::uuid`
    : sql``;

  const rows = (await db.execute(sql`
    SELECT
      dec.id          AS decision_id,
      dec.doc_id      AS doc_id,
      dec.seq         AS dec_seq,
      dec.title       AS dec_title,
      dec.context     AS dec_context,
      dec.resolution  AS dec_resolution,
      dec.status      AS dec_status,
      dec.created_at  AS created_at,
      dec.resolved_at AS resolved_at,
      COALESCE(NULLIF(TRIM(dec.actor_name), ''), NULLIF(TRIM(au.name), ''), au.email) AS author_name,
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.doc_type      AS doc_type,
      (dec.embedding <=> ${literal}::vector) AS distance
    FROM decisions dec
    INNER JOIN documents d ON d.id = dec.doc_id
    LEFT JOIN users au ON au.id = dec.actor_user_id
    WHERE dec.memex_id = ${memexId}
      ${archivedClause}
      AND d.is_demo IS NOT TRUE
      ${excludeClause}
      AND dec.embedding IS NOT NULL
      AND dec.embedding_model = ${queryVec.model}
      AND (dec.embedding <=> ${literal}::vector) < ${maxDistance}
    ORDER BY dec.embedding <=> ${literal}::vector
    LIMIT 50
  `)) as unknown as DecisionRow[];
  return rows;
}

// ── Issue FTS ──────────────────────────────────────────
// Same shape as the decision arm (spec-112 t-4). Issues live in their own
// `issues` table (0068_issues.sql) — bug/todo backlog raised against a Spec.
//
// Index-served via `issues.content_tsv` — a STORED generated column over
// title + body, with a GIN index (migration 0132, spec-522 t-1). This arm
// carried the identical inline-to_tsvector anti-pattern as the decision arm, and
// the identical wrong comment ("cheap: the issues table is small relative to
// doc_sections"). It was cheap only because `issues` is still small — spec-522
// s-2 used it as the experimental CONTROL for exactly that reason: same code
// shape, small corpus, 356 ms versus the decision arm's 784 ms. It was the next
// decisions arm, so it was fixed in the same migration rather than waited for
// [per std-39: reason about growth, not present cost]. The join to
// `documents` is on `iss.doc_id` (the parent Spec), giving us the handle +
// docType needed to build the `/issues/issue-N` path.

export async function runIssueFts(
  memexId: string,
  query: string,
  includeArchived: boolean,
  excludeDocId?: string,
): Promise<IssueRow[]> {
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL`;
  const excludeClause = excludeDocId
    ? sql`AND iss.doc_id <> ${excludeDocId}::uuid`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT
      iss.id          AS issue_id,
      iss.doc_id      AS doc_id,
      iss.seq         AS issue_seq,
      iss.title       AS issue_title,
      iss.body        AS issue_body,
      iss.type        AS issue_type,
      iss.status      AS issue_status,
      iss.updated_at  AS updated_at,
      COALESCE(NULLIF(TRIM(au.name), ''), au.email) AS author_name,
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.doc_type      AS doc_type,
      ts_rank(iss.content_tsv, plainto_tsquery('english', ${query})) AS rank
    FROM issues iss
    INNER JOIN documents d ON d.id = iss.doc_id
    LEFT JOIN users au ON au.id = iss.created_by_user_id
    WHERE iss.memex_id = ${memexId}
      ${archivedClause}
      AND d.is_demo IS NOT TRUE
      ${excludeClause}
      AND iss.content_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT 50
  `)) as unknown as IssueRow[];
  return rows;
}

// ── Issue Vector ───────────────────────────────────────

export async function runIssueVector(
  memexId: string,
  includeArchived: boolean,
  queryVec: ResolvedQueryVector,
  maxDistance: number,
  excludeDocId?: string,
): Promise<IssueRow[]> {
  // spec-522 dec-1 — see runSectionVector: the embed happens once, upstream.
  const literal = `[${queryVec.vector.join(",")}]`;
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL`;
  const excludeClause = excludeDocId
    ? sql`AND iss.doc_id <> ${excludeDocId}::uuid`
    : sql``;

  const rows = (await db.execute(sql`
    SELECT
      iss.id          AS issue_id,
      iss.doc_id      AS doc_id,
      iss.seq         AS issue_seq,
      iss.title       AS issue_title,
      iss.body        AS issue_body,
      iss.type        AS issue_type,
      iss.status      AS issue_status,
      iss.updated_at  AS updated_at,
      COALESCE(NULLIF(TRIM(au.name), ''), au.email) AS author_name,
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.doc_type      AS doc_type,
      (iss.embedding <=> ${literal}::vector) AS distance
    FROM issues iss
    INNER JOIN documents d ON d.id = iss.doc_id
    LEFT JOIN users au ON au.id = iss.created_by_user_id
    WHERE iss.memex_id = ${memexId}
      ${archivedClause}
      AND d.is_demo IS NOT TRUE
      ${excludeClause}
      AND iss.embedding IS NOT NULL
      AND iss.embedding_model = ${queryVec.model}
      AND (iss.embedding <=> ${literal}::vector) < ${maxDistance}
    ORDER BY iss.embedding <=> ${literal}::vector
    LIMIT 50
  `)) as unknown as IssueRow[];
  return rows;
}
