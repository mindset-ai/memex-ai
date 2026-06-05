// Unified search across the entire Memex (b-34 — generalised from the
// standards-only search shipped in doc-8 t-6).
//
// Searches Specs, Standards, free-form documents, and Decisions inside a
// single Memex. Result format is markdown with the canonical URL path as the
// per-hit heading (per b-34 D-4 + b-36 D-1/D-2/D-7 — no UUIDs in output).
//
// Three lookup strategies, merged into one ranked result list:
//
//   1. Handle exact lookup. If the query is `spec-N`, `std-N`, `doc-N`
//      (Spec / Standard / free-form doc), short-circuit to a direct lookup.
//      Highest confidence; always wins the ranking. Per b-36 D-5/D-8 UUIDs
//      are no longer accepted at the MCP boundary — UUID-shape queries fall
//      through to the normal FTS / vector path (they'll match nothing useful,
//      which is the correct behaviour for an opaque identifier we don't
//      recognise). Decisions can be addressed via the qualified
//      `<docHandle>:dec-N` shape (handled by
//      services/decisions.ts:getDecisionByHandle, NOT this file — keeps the
//      cross-table resolution rules in one place).
//
//   2. Full-text search via Postgres tsvector. For sections,
//      `doc_sections.content_tsv` (generated column added in
//      0027_v2_deferral_fixes). For decisions, an inline
//      `to_tsvector('english', title || context || resolution)` since the
//      `decisions` table doesn't carry a generated tsvector column.
//
//   3. Vector cosine search via pgvector. For sections,
//      `doc_sections.embedding` (HNSW index from 0032). For decisions,
//      `decisions.embedding` (HNSW index from 0052). Catches paraphrased
//      queries that lexical FTS would miss. Bounded by a cosine-distance
//      relevance floor (DEFAULT_MAX_VECTOR_DISTANCE) so a low-signal query
//      doesn't surface unrelated nearest neighbours — see spec-64 i-1.
//
// FTS + vector results are merged by reciprocal-rank-fusion (RRF) so callers
// don't need to tune a similarity-vs-rank threshold. Section hits group under
// their parent doc; decision hits are atomic. The search method (FTS vs
// vector) is recorded per-result for debug / telemetry.
//
// Archived and paused content is excluded by default (per b-34 spec
// requirement); `includeArchived: true` opts back in.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  resolveEmbeddingProvider,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { listSpecsAssignedToUser } from "./doc-assignees.js";

const HANDLE_REGEX = /^(spec|std|doc)-\d+$/i;

// Reciprocal-rank-fusion constant. 60 is the canonical default from the
// original Cormack/Clarke 2009 paper. Lower k weights top ranks more heavily,
// higher k flattens the curve. Keep at 60 unless we have measurements that
// disagree.
const RRF_K = 60;

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

function resolveMaxVectorDistance(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const env = process.env.MEMEX_SEARCH_MAX_VECTOR_DISTANCE;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_VECTOR_DISTANCE;
}

export type SearchStrategy = "handle" | "fts" | "vector";

// Per b-34 D-2: phase-1 scope. `kind` is optional — omit to search every
// kind. Tasks, comments, execution-plan sections deferred (easy to add as
// additional kinds later). Issues (spec-112 t-4) join the decision arm as a
// second non-section kind — same RRF FTS+vector machinery, no new search
// infra (s-4): they ride their own table's title/body + embedding column.
export type MemexSearchKind = "spec" | "standard" | "document" | "decision" | "issue";

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

export interface MatchingSection {
  id: string;
  sectionType: string;
  title: string | null;
  content: string;
  /** Which search method surfaced this section first. */
  matchedVia: SearchStrategy;
}

export interface MemexSearchHit {
  /** Internal UUID — never rendered. The path is the public identifier. */
  id: string;
  kind: MemexSearchKind;
  /** Canonical URL path for this hit (no scheme/host). For decisions:
   *  `<ns>/<mx>/<docTypePath>/<docHandle>/decisions/dec-N`.
   *  For docs: `<ns>/<mx>/<docTypePath>/<docHandle>`. */
  path: string;
  title: string;
  /** Status / phase. For docs: docStatus. For decisions: decisionStatus. */
  status: string;
  /** Aggregated rank score after RRF merge. Higher = better. */
  score: number;
  /** Strategies that contributed at least one hit. */
  strategies: SearchStrategy[];
  /** Sections that matched (only populated for kind != 'decision'). */
  matchingSections: MatchingSection[];
  /** Snippet for decision hits (matched chunk, ≤ 300 chars). */
  decisionSnippet?: string;
  /** Search method that surfaced this decision (only for kind='decision'). */
  decisionMatchedVia?: SearchStrategy;
  /** Snippet for issue hits (matched chunk, ≤ 300 chars). spec-112 t-4. */
  issueSnippet?: string;
  /** Search method that surfaced this issue (only for kind='issue'). */
  issueMatchedVia?: SearchStrategy;
  /** bug | todo — surfaced in the issue hit heading so a search reader can
   *  tell a bug from a todo without opening it (only for kind='issue'). */
  issueType?: string;
  /** Parent doc UUID. For section/doc hits this equals `id`. For decision
   *  hits this is the parent Spec's UUID. Internal — never rendered, but
   *  used to detect self-hits when the caller passes `currentDocId` to the
   *  formatter. */
  parentDocId: string;
}

export interface SearchMemexOptions {
  /** Restrict to one entity kind. Omit for all. */
  kind?: MemexSearchKind;
  /** Cap on returned hits. Default 8 — tighter than standards-search to
   *  protect agent context (per b-34 D-4). */
  limit?: number;
  /** Force off vector search even when a provider is configured (e.g. test
   *  mode). */
  disableVector?: boolean;
  /** Inject a deterministic provider; tests use this to avoid API calls. */
  provider?: EmbeddingProvider | null;
  /** Include archived / paused content. Default false. */
  includeArchived?: boolean;
  /** Max cosine distance for a vector hit to count as relevant — the semantic
   *  relevance floor (spec-64 i-1). Vector hits at or beyond this distance are
   *  dropped so a low-signal query doesn't surface unrelated nearest-neighbour
   *  sections. Defaults to MEMEX_SEARCH_MAX_VECTOR_DISTANCE env, else
   *  DEFAULT_MAX_VECTOR_DISTANCE. FTS hits are never floored. */
  maxVectorDistance?: number;
  /** Exclude hits whose section's doc_id (or decision's parent doc_id)
   *  matches this UUID. The in-app agent binds the current doc here so
   *  search results don't include the very Spec being edited (the
   *  agent already has it in its Document Context system block). MCP
   *  callers omit this; unset = no filter. */
  excludeDocId?: string;
}

interface SectionRow {
  section_id: string;
  doc_id: string;
  section_type: string;
  section_title: string | null;
  section_content: string;
  doc_handle: string;
  doc_title: string;
  doc_status: string;
  doc_type: string;
  rank?: number; // FTS ts_rank
  distance?: number; // vector cosine distance
}

interface DecisionRow {
  decision_id: string;
  doc_id: string;
  doc_handle: string;
  doc_title: string;
  doc_type: string;
  dec_seq: number;
  dec_title: string;
  dec_context: string | null;
  dec_resolution: string | null;
  dec_status: string;
  rank?: number;
  distance?: number;
}

interface IssueRow {
  issue_id: string;
  doc_id: string;
  doc_handle: string;
  doc_title: string;
  doc_type: string;
  issue_seq: number;
  issue_title: string;
  issue_body: string | null;
  issue_type: string;
  issue_status: string;
  rank?: number;
  distance?: number;
}

// Resolved Memex slug parts — needed to build canonical paths.
interface MemexSlugs {
  namespace_slug: string;
  memex_slug: string;
}

async function loadMemexSlugs(memexId: string): Promise<MemexSlugs | null> {
  const rows = (await db.execute(sql`
    SELECT n.slug AS namespace_slug, m.slug AS memex_slug
    FROM memexes m
    INNER JOIN namespaces n ON n.id = m.namespace_id
    WHERE m.id = ${memexId}
    LIMIT 1
  `)) as unknown as MemexSlugs[];
  return rows[0] ?? null;
}

// docType → URL path segment. Matches the routing convention: specs at
// /specs, standards at /standards, free-form at /docs, execution plans at
// /execution-plans.
function docTypeToPathSegment(docType: string): string {
  if (docType === "spec") return "specs";
  if (docType === "standard") return "standards";
  if (docType === "execution_plan") return "execution-plans";
  return "docs"; // document, adr, runbook, etc.
}

function buildDocPath(slugs: MemexSlugs, docType: string, handle: string): string {
  return `${slugs.namespace_slug}/${slugs.memex_slug}/${docTypeToPathSegment(docType)}/${handle}`;
}

function buildDecisionPath(
  slugs: MemexSlugs,
  parentDocType: string,
  parentHandle: string,
  decSeq: number,
): string {
  return `${buildDocPath(slugs, parentDocType, parentHandle)}/decisions/dec-${decSeq}`;
}

// Issues hang off a Spec under `/issues/issue-N`, mirroring how decisions hang off
// `/decisions/dec-N` (spec-112 t-4). The `issue-N` handle is the per-Spec issue seq
// minted by services/issues.ts — same shape rule as dec-N (renamed from `i-N` per
// spec-158 dec-3).
function buildIssuePath(
  slugs: MemexSlugs,
  parentDocType: string,
  parentHandle: string,
  issueSeq: number,
): string {
  return `${buildDocPath(slugs, parentDocType, parentHandle)}/issues/issue-${issueSeq}`;
}

function kindForDocType(docType: string): MemexSearchKind {
  if (docType === "spec") return "spec";
  if (docType === "standard") return "standard";
  return "document";
}

function inScopeDocTypes(kind: MemexSearchKind | undefined): string[] | null {
  if (!kind) return ALL_SECTION_DOC_TYPES;
  // decision + issue are non-section kinds — their own arms run instead, so the
  // section query short-circuits to nothing.
  if (kind === "decision" || kind === "issue") return null;
  return DOC_TYPES_BY_KIND[kind];
}

// ── Public entry point ─────────────────────────────────

export async function searchMemex(
  memexId: string,
  query: string,
  options: SearchMemexOptions = {},
): Promise<MemexSearchHit[]> {
  const trimmed = (query ?? "").trim();
  if (trimmed.length === 0) return [];

  const limit = options.limit ?? 8;
  const includeArchived = options.includeArchived ?? false;
  const excludeDocId = options.excludeDocId;

  const slugs = await loadMemexSlugs(memexId);
  if (!slugs) return [];

  // 1. Handle short-circuit — exact lookup wins. Direct lookups bypass
  //    the self-filter: if you explicitly named the doc, you want it back.
  //    (UUIDs no longer accepted per b-36 D-5/D-8; UUID-shape queries fall
  //    through to FTS/vector.)
  if (HANDLE_REGEX.test(trimmed)) {
    const direct = await lookupByHandle(memexId, slugs, trimmed, includeArchived);
    if (direct) return [direct];
    // Fall through to fuzzy search if nothing matched (the user might have
    // typed a handle that doesn't exist; better to show paraphrase candidates
    // than an empty result).
  }

  const provider =
    options.provider !== undefined ? options.provider : resolveEmbeddingProvider();
  const disableVector = options.disableVector === true || provider === null;
  const maxVectorDistance = resolveMaxVectorDistance(options.maxVectorDistance);

  const sectionDocTypes = inScopeDocTypes(options.kind);
  const includeDecisions =
    options.kind === undefined || options.kind === "decision";
  const includeIssues =
    options.kind === undefined || options.kind === "issue";

  // 2. Run FTS + vector across all arms in parallel.
  const sectionTasks = sectionDocTypes
    ? [
        runSectionFts(memexId, trimmed, sectionDocTypes, includeArchived, excludeDocId),
        disableVector || !provider
          ? Promise.resolve<SectionRow[]>([])
          : runSectionVector(
              memexId,
              trimmed,
              sectionDocTypes,
              includeArchived,
              provider,
              maxVectorDistance,
              excludeDocId,
            ),
      ]
    : [Promise.resolve<SectionRow[]>([]), Promise.resolve<SectionRow[]>([])];

  const decisionTasks = includeDecisions
    ? [
        runDecisionFts(memexId, trimmed, includeArchived, excludeDocId),
        disableVector || !provider
          ? Promise.resolve<DecisionRow[]>([])
          : runDecisionVector(
              memexId,
              trimmed,
              includeArchived,
              provider,
              maxVectorDistance,
              excludeDocId,
            ),
      ]
    : [Promise.resolve<DecisionRow[]>([]), Promise.resolve<DecisionRow[]>([])];

  const issueTasks = includeIssues
    ? [
        runIssueFts(memexId, trimmed, includeArchived, excludeDocId),
        disableVector || !provider
          ? Promise.resolve<IssueRow[]>([])
          : runIssueVector(
              memexId,
              trimmed,
              includeArchived,
              provider,
              maxVectorDistance,
              excludeDocId,
            ),
      ]
    : [Promise.resolve<IssueRow[]>([]), Promise.resolve<IssueRow[]>([])];

  const [
    sectionFts,
    sectionVector,
    decisionFts,
    decisionVector,
    issueFts,
    issueVector,
  ] = await Promise.all([
    sectionTasks[0],
    sectionTasks[1],
    decisionTasks[0],
    decisionTasks[1],
    issueTasks[0],
    issueTasks[1],
  ]);

  return mergeWithRrf(
    sectionFts as SectionRow[],
    sectionVector as SectionRow[],
    decisionFts as DecisionRow[],
    decisionVector as DecisionRow[],
    issueFts as IssueRow[],
    issueVector as IssueRow[],
    slugs,
    limit,
  );
}

// ── Direct lookup ──────────────────────────────────────

async function lookupByHandle(
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
      s.doc_id        AS doc_id,
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.status        AS doc_status,
      d.doc_type      AS doc_type
    FROM documents d
    LEFT JOIN doc_sections s ON s.doc_id = d.id
    WHERE d.memex_id = ${memexId}
      ${archivedClause}
      AND d.handle = ${query.toLowerCase()}
    ORDER BY s.seq
  `)) as unknown as SectionRow[];

  if (rows.length === 0) return null;

  const first = rows[0];
  return {
    id: first.doc_id,
    parentDocId: first.doc_id,
    kind: kindForDocType(first.doc_type),
    path: buildDocPath(slugs, first.doc_type, first.doc_handle),
    title: first.doc_title,
    status: first.doc_status,
    score: 1,
    strategies: ["handle"],
    matchingSections: rows
      .filter((r) => r.section_id != null)
      .map((r) => ({
        id: r.section_id,
        sectionType: r.section_type,
        title: r.section_title,
        content: r.section_content,
        matchedVia: "handle",
      })),
  };
}

// ── Jump-to lane (spec-64 t-2) ─────────────────────────
// The omnibox's "Jump to" tier: high-confidence, doc-level navigation hints
// that sit ABOVE the fuzzy content tier (ac-17/ac-18). Two strategies, merged
// (exact handle first, then case-insensitive Spec title-substring):
//
//   1. Exact handle (ac-17). `spec-N` / `std-N` / `doc-N` resolves directly via
//      the SAME lookupByHandle the search core uses for its handle short-circuit
//      — reusing the resolution rather than reinventing it, so the jump lane and
//      the content lane agree on what a handle points at.
//   2. Spec title-substring (ac-18). A free-text query that appears inside a
//      Spec's TITLE (docType='spec' only, per "Spec title") surfaces that Spec
//      so you can jump straight to it even when the title text isn't strong
//      enough to win the FTS content ranking. ILIKE = case-insensitive contains.
//
// Visibility posture matches the content tier EXACTLY (ac per design): archived
// AND paused excluded, drafts included (NO status filter). Note lookupByHandle
// only filters archived; we re-check paused in resolveJumpTo's dedicated query
// path for the title arm, and accept the handle arm's archived-only filter since
// a paused doc you named by exact handle is still a legitimate jump target (it
// can't surface in the content tier, but the handle tier is "I know exactly what
// I want"). The route projects these MemexSearchHit[] through the same public,
// UUID-stripped shape as content.

// Cap on title-substring jump hits. The jump lane is a short, high-signal list;
// 5 keeps it scannable without flooding the omnibox.
const JUMP_TITLE_LIMIT = 5;

interface JumpTitleRow {
  doc_id: string;
  doc_handle: string;
  doc_title: string;
  doc_status: string;
  doc_type: string;
}

export async function resolveJumpTo(
  memexId: string,
  query: string,
): Promise<MemexSearchHit[]> {
  const trimmed = (query ?? "").trim();
  if (trimmed.length === 0) return [];

  const slugs = await loadMemexSlugs(memexId);
  if (!slugs) return [];

  const hits: MemexSearchHit[] = [];
  const seenDocIds = new Set<string>();

  // 1. Exact handle (ac-17) — reuse the core's handle resolver. includeArchived
  //    is false to match the content tier's archived-excluded posture.
  if (HANDLE_REGEX.test(trimmed)) {
    const direct = await lookupByHandle(memexId, slugs, trimmed, false);
    if (direct) {
      hits.push(direct);
      seenDocIds.add(direct.id);
    }
  }

  // 2. Spec title-substring (ac-18) — docType='spec' only ("Spec title"),
  //    case-insensitive contains. Same archived/paused exclusion as the content
  //    tier; NO status filter so drafts are eligible. ESCAPE the LIKE wildcards
  //    in the user's text so `%`/`_` are treated literally.
  const escaped = trimmed.replace(/([\\%_])/g, "\\$1");
  const pattern = `%${escaped}%`;
  const titleRows = (await db.execute(sql`
    SELECT
      d.id        AS doc_id,
      d.handle    AS doc_handle,
      d.title     AS doc_title,
      d.status    AS doc_status,
      d.doc_type  AS doc_type
    FROM documents d
    WHERE d.memex_id = ${memexId}
      AND d.doc_type = 'spec'
      AND d.archived_at IS NULL
      AND d.paused_at IS NULL
      AND d.title ILIKE ${pattern} ESCAPE '\\'
    ORDER BY length(d.title) ASC, d.title ASC
    LIMIT ${JUMP_TITLE_LIMIT}
  `)) as unknown as JumpTitleRow[];

  for (const r of titleRows) {
    // Dedupe against the handle hit: if the exact-handle arm already returned
    // this Spec, don't list it twice in the jump lane.
    if (seenDocIds.has(r.doc_id)) continue;
    seenDocIds.add(r.doc_id);
    hits.push({
      id: r.doc_id,
      parentDocId: r.doc_id,
      kind: kindForDocType(r.doc_type),
      path: buildDocPath(slugs, r.doc_type, r.doc_handle),
      title: r.doc_title,
      status: r.doc_status,
      // Title-substring is a weaker signal than an exact handle (score 1 above),
      // so it ranks below the handle hit but is still a deliberate jump target.
      score: 0.5,
      strategies: ["handle"],
      matchingSections: [],
    });
  }

  return hits;
}

// ── Assigned lane (spec-64 t-2 / ac-19) ────────────────
// The omnibox's "assigned to @<name>" tier. Given the user(s) an `@<name>`
// query resolved to (services/users.ts:resolveOrgMembersByName), return the
// Specs assigned to them in THIS memex as navigable hits. The assignment data
// itself comes from the spec-118 doc_assignees relation
// (doc-assignees.ts:listSpecsAssignedToUser, which applies the same
// archived/paused exclusion + no-status-filter posture as the content tier).
// Here we only own the slug/path projection — building the canonical doc path
// so the hit is a jump target, identical to how the section/handle arms do it.
// A Spec assigned to two matched people (an ambiguous `@al`) is deduped so it
// appears once.
export async function resolveAssignedSpecs(
  memexId: string,
  userIds: string[],
): Promise<MemexSearchHit[]> {
  if (userIds.length === 0) return [];

  const slugs = await loadMemexSlugs(memexId);
  if (!slugs) return [];

  const hits: MemexSearchHit[] = [];
  const seenDocIds = new Set<string>();
  for (const userId of userIds) {
    const rows = await listSpecsAssignedToUser(memexId, userId);
    for (const r of rows) {
      if (seenDocIds.has(r.docId)) continue;
      seenDocIds.add(r.docId);
      hits.push({
        id: r.docId,
        parentDocId: r.docId,
        kind: kindForDocType(r.docType),
        path: buildDocPath(slugs, r.docType, r.handle),
        title: r.title,
        status: r.status,
        score: 1,
        // "assignment" isn't a search channel (it's a relation, not FTS/vector/
        // handle); the closest existing label is the direct, non-fuzzy "handle"
        // tier, so we reuse it rather than widening the SearchStrategy union for
        // a lane the formatter never renders.
        strategies: ["handle"],
        matchingSections: [],
      });
    }
  }
  return hits;
}

// ── Section FTS ────────────────────────────────────────

async function runSectionFts(
  memexId: string,
  query: string,
  docTypes: string[],
  includeArchived: boolean,
  excludeDocId?: string,
): Promise<SectionRow[]> {
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL AND d.paused_at IS NULL`;
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
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.status        AS doc_status,
      d.doc_type      AS doc_type,
      ts_rank(s.content_tsv, plainto_tsquery('english', ${query})) AS rank
    FROM doc_sections s
    INNER JOIN documents d ON d.id = s.doc_id
    WHERE d.memex_id = ${memexId}
      AND d.doc_type IN ${sql.raw(`(${docTypes.map((t) => `'${t}'`).join(",")})`)}
      ${archivedClause}
      ${excludeClause}
      AND (s.status <> 'deleted' OR s.status IS NULL)
      AND s.content_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT 50
  `)) as unknown as SectionRow[];
  return rows;
}

// ── Section Vector ─────────────────────────────────────

async function runSectionVector(
  memexId: string,
  query: string,
  docTypes: string[],
  includeArchived: boolean,
  provider: EmbeddingProvider,
  maxDistance: number,
  excludeDocId?: string,
): Promise<SectionRow[]> {
  let queryVec: number[];
  try {
    [queryVec] = await provider.embed([query], "query");
  } catch {
    return [];
  }
  if (!queryVec) return [];

  const literal = `[${queryVec.join(",")}]`;
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL AND d.paused_at IS NULL`;
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
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.status        AS doc_status,
      d.doc_type      AS doc_type,
      (s.embedding <=> ${literal}::vector) AS distance
    FROM doc_sections s
    INNER JOIN documents d ON d.id = s.doc_id
    WHERE d.memex_id = ${memexId}
      AND d.doc_type IN ${sql.raw(`(${docTypes.map((t) => `'${t}'`).join(",")})`)}
      ${archivedClause}
      ${excludeClause}
      AND (s.status <> 'deleted' OR s.status IS NULL)
      AND s.embedding IS NOT NULL
      AND s.embedding_model = ${provider.name}
      AND (s.embedding <=> ${literal}::vector) < ${maxDistance}
    ORDER BY s.embedding <=> ${literal}::vector
    LIMIT 50
  `)) as unknown as SectionRow[];
  return rows;
}

// ── Decision FTS ───────────────────────────────────────
// Inline tsvector since `decisions` doesn't have a generated content_tsv
// column. Concatenate title + context + resolution at query time. Cost is
// modest because the table is small relative to doc_sections.

async function runDecisionFts(
  memexId: string,
  query: string,
  includeArchived: boolean,
  excludeDocId?: string,
): Promise<DecisionRow[]> {
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL AND d.paused_at IS NULL`;
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
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.doc_type      AS doc_type,
      ts_rank(
        to_tsvector('english',
          coalesce(dec.title, '') || ' ' ||
          coalesce(dec.context, '') || ' ' ||
          coalesce(dec.resolution, '')),
        plainto_tsquery('english', ${query})
      ) AS rank
    FROM decisions dec
    INNER JOIN documents d ON d.id = dec.doc_id
    WHERE dec.memex_id = ${memexId}
      ${archivedClause}
      ${excludeClause}
      AND to_tsvector('english',
            coalesce(dec.title, '') || ' ' ||
            coalesce(dec.context, '') || ' ' ||
            coalesce(dec.resolution, ''))
          @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT 50
  `)) as unknown as DecisionRow[];
  return rows;
}

// ── Decision Vector ────────────────────────────────────

async function runDecisionVector(
  memexId: string,
  query: string,
  includeArchived: boolean,
  provider: EmbeddingProvider,
  maxDistance: number,
  excludeDocId?: string,
): Promise<DecisionRow[]> {
  let queryVec: number[];
  try {
    [queryVec] = await provider.embed([query], "query");
  } catch {
    return [];
  }
  if (!queryVec) return [];

  const literal = `[${queryVec.join(",")}]`;
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL AND d.paused_at IS NULL`;
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
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.doc_type      AS doc_type,
      (dec.embedding <=> ${literal}::vector) AS distance
    FROM decisions dec
    INNER JOIN documents d ON d.id = dec.doc_id
    WHERE dec.memex_id = ${memexId}
      ${archivedClause}
      ${excludeClause}
      AND dec.embedding IS NOT NULL
      AND dec.embedding_model = ${provider.name}
      AND (dec.embedding <=> ${literal}::vector) < ${maxDistance}
    ORDER BY dec.embedding <=> ${literal}::vector
    LIMIT 50
  `)) as unknown as DecisionRow[];
  return rows;
}

// ── Issue FTS ──────────────────────────────────────────
// Same shape as the decision arm (spec-112 t-4). Issues live in their own
// `issues` table (0068_issues.sql) — bug/todo backlog raised against a Spec —
// with no generated tsvector column, so we concatenate title + body at query
// time. Cheap: the issues table is small relative to doc_sections. The join to
// `documents` is on `iss.doc_id` (the parent Spec), giving us the handle +
// docType needed to build the `/issues/issue-N` path.

async function runIssueFts(
  memexId: string,
  query: string,
  includeArchived: boolean,
  excludeDocId?: string,
): Promise<IssueRow[]> {
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL AND d.paused_at IS NULL`;
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
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.doc_type      AS doc_type,
      ts_rank(
        to_tsvector('english',
          coalesce(iss.title, '') || ' ' ||
          coalesce(iss.body, '')),
        plainto_tsquery('english', ${query})
      ) AS rank
    FROM issues iss
    INNER JOIN documents d ON d.id = iss.doc_id
    WHERE iss.memex_id = ${memexId}
      ${archivedClause}
      ${excludeClause}
      AND to_tsvector('english',
            coalesce(iss.title, '') || ' ' ||
            coalesce(iss.body, ''))
          @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT 50
  `)) as unknown as IssueRow[];
  return rows;
}

// ── Issue Vector ───────────────────────────────────────

async function runIssueVector(
  memexId: string,
  query: string,
  includeArchived: boolean,
  provider: EmbeddingProvider,
  maxDistance: number,
  excludeDocId?: string,
): Promise<IssueRow[]> {
  let queryVec: number[];
  try {
    [queryVec] = await provider.embed([query], "query");
  } catch {
    return [];
  }
  if (!queryVec) return [];

  const literal = `[${queryVec.join(",")}]`;
  const archivedClause = includeArchived
    ? sql``
    : sql`AND d.archived_at IS NULL AND d.paused_at IS NULL`;
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
      d.handle        AS doc_handle,
      d.title         AS doc_title,
      d.doc_type      AS doc_type,
      (iss.embedding <=> ${literal}::vector) AS distance
    FROM issues iss
    INNER JOIN documents d ON d.id = iss.doc_id
    WHERE iss.memex_id = ${memexId}
      ${archivedClause}
      ${excludeClause}
      AND iss.embedding IS NOT NULL
      AND iss.embedding_model = ${provider.name}
      AND (iss.embedding <=> ${literal}::vector) < ${maxDistance}
    ORDER BY iss.embedding <=> ${literal}::vector
    LIMIT 50
  `)) as unknown as IssueRow[];
  return rows;
}

// ── RRF merge ──────────────────────────────────────────

interface AccumulatorEntry {
  id: string;
  parentDocId: string;
  kind: MemexSearchKind;
  path: string;
  title: string;
  status: string;
  score: number;
  strategies: Set<SearchStrategy>;
  sectionsByVia: Map<string, MatchingSection>;
  decisionSnippet?: string;
  decisionMatchedVia?: SearchStrategy;
  issueSnippet?: string;
  issueMatchedVia?: SearchStrategy;
  issueType?: string;
}

function pickDecisionSnippet(r: DecisionRow): string {
  // Prefer resolution → context → title for the snippet body. Cap at 300 chars
  // (b-34 D-4).
  const candidate =
    (r.dec_resolution && r.dec_resolution.trim()) ||
    (r.dec_context && r.dec_context.trim()) ||
    r.dec_title;
  return candidate.length > 300 ? `${candidate.slice(0, 297)}…` : candidate;
}

function pickIssueSnippet(r: IssueRow): string {
  // Prefer body → title for the snippet body (an Issue's body carries the
  // detail; the title is the one-liner). Cap at 300 chars (b-34 D-4).
  const candidate =
    (r.issue_body && r.issue_body.trim()) || r.issue_title;
  return candidate.length > 300 ? `${candidate.slice(0, 297)}…` : candidate;
}

function mergeWithRrf(
  sectionFts: SectionRow[],
  sectionVector: SectionRow[],
  decisionFts: DecisionRow[],
  decisionVector: DecisionRow[],
  issueFts: IssueRow[],
  issueVector: IssueRow[],
  slugs: MemexSlugs,
  limit: number,
): MemexSearchHit[] {
  // Sections: keyed by doc_id (group multiple matching sections under one
  // parent doc). Decisions: keyed by decision_id (atomic).
  const acc = new Map<string, AccumulatorEntry>();

  function addSectionRows(rows: SectionRow[], via: SearchStrategy): void {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rrfContribution = 1 / (RRF_K + i + 1);
      let entry = acc.get(`doc:${r.doc_id}`);
      if (!entry) {
        entry = {
          id: r.doc_id,
          parentDocId: r.doc_id,
          kind: kindForDocType(r.doc_type),
          path: buildDocPath(slugs, r.doc_type, r.doc_handle),
          title: r.doc_title,
          status: r.doc_status,
          score: 0,
          strategies: new Set<SearchStrategy>(),
          sectionsByVia: new Map(),
        };
        acc.set(`doc:${r.doc_id}`, entry);
      }
      entry.score += rrfContribution;
      entry.strategies.add(via);

      // Keep the FIRST `via` that surfaced each section so a section seen by
      // both FTS and vector reports the higher-confidence search method.
      if (!entry.sectionsByVia.has(r.section_id)) {
        entry.sectionsByVia.set(r.section_id, {
          id: r.section_id,
          sectionType: r.section_type,
          title: r.section_title,
          content: r.section_content,
          matchedVia: via,
        });
      }
    }
  }

  function addDecisionRows(rows: DecisionRow[], via: SearchStrategy): void {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rrfContribution = 1 / (RRF_K + i + 1);
      let entry = acc.get(`dec:${r.decision_id}`);
      if (!entry) {
        entry = {
          id: r.decision_id,
          parentDocId: r.doc_id,
          kind: "decision",
          path: buildDecisionPath(slugs, r.doc_type, r.doc_handle, r.dec_seq),
          title: r.dec_title,
          status: r.dec_status,
          score: 0,
          strategies: new Set<SearchStrategy>(),
          sectionsByVia: new Map(),
          decisionSnippet: pickDecisionSnippet(r),
          decisionMatchedVia: via,
        };
        acc.set(`dec:${r.decision_id}`, entry);
      } else {
        // Already present from the other arm — preserve original snippet/via
        // (first-wins), but boost the score.
      }
      entry.score += rrfContribution;
      entry.strategies.add(via);
    }
  }

  function addIssueRows(rows: IssueRow[], via: SearchStrategy): void {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rrfContribution = 1 / (RRF_K + i + 1);
      let entry = acc.get(`iss:${r.issue_id}`);
      if (!entry) {
        entry = {
          id: r.issue_id,
          parentDocId: r.doc_id,
          kind: "issue",
          path: buildIssuePath(slugs, r.doc_type, r.doc_handle, r.issue_seq),
          title: r.issue_title,
          status: r.issue_status,
          score: 0,
          strategies: new Set<SearchStrategy>(),
          sectionsByVia: new Map(),
          issueSnippet: pickIssueSnippet(r),
          issueMatchedVia: via,
          issueType: r.issue_type,
        };
        acc.set(`iss:${r.issue_id}`, entry);
      } else {
        // Already present from the other arm — preserve original snippet/via
        // (first-wins), but boost the score. Mirrors addDecisionRows.
      }
      entry.score += rrfContribution;
      entry.strategies.add(via);
    }
  }

  addSectionRows(sectionFts, "fts");
  addSectionRows(sectionVector, "vector");
  addDecisionRows(decisionFts, "fts");
  addDecisionRows(decisionVector, "vector");
  addIssueRows(issueFts, "fts");
  addIssueRows(issueVector, "vector");

  const results: MemexSearchHit[] = Array.from(acc.values()).map((e) => ({
    id: e.id,
    kind: e.kind,
    path: e.path,
    parentDocId: e.parentDocId,
    title: e.title,
    status: e.status,
    score: e.score,
    strategies: Array.from(e.strategies).sort(),
    matchingSections: Array.from(e.sectionsByVia.values()),
    decisionSnippet: e.decisionSnippet,
    decisionMatchedVia: e.decisionMatchedVia,
    issueSnippet: e.issueSnippet,
    issueMatchedVia: e.issueMatchedVia,
    issueType: e.issueType,
  }));

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ══════════════════════════════════════════════════════════
// Markdown formatter (b-34 D-4)
// ══════════════════════════════════════════════════════════
//
// Renders MemexSearchHit[] to the path-as-heading markdown spec:
//
//   ### <canonical-path> — "<title>" (<kind>, <status>)
//   - Section "<section-title>" (<fts|vector>):
//     > snippet ≤ 300 chars …
//
// For decisions:
//
//   ### …/specs/spec-N/decisions/dec-M — "<title>" (decision, <status>)
//   - (<fts|vector>): <snippet>
//
// No UUIDs anywhere (per b-36 D-2/D-7). Score / URL omitted in terse mode;
// `verbose: true` adds score for debug.

const SNIPPET_MAX_CHARS = 300;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export interface FormatOptions {
  verbose?: boolean;
  /** When set, hits whose doc id matches (decision hits: parent doc id) get a
   *  trailing `[current doc]` tag so the agent recognises results that belong
   *  to the Spec it's currently editing rather than treating them as
   *  external prior work. Only relevant when search_memex was called with
   *  `includeCurrentDoc: true` (the default excludes the current doc from
   *  results entirely, so this never fires). */
  currentDocId?: string;
}

function isHitOnCurrentDoc(hit: MemexSearchHit, currentDocId: string): boolean {
  // parentDocId is the doc UUID for section/doc hits and the parent Spec's
  // UUID for decision hits. Matching here means the hit belongs to the
  // Spec the agent is currently editing.
  return hit.parentDocId === currentDocId;
}

export function formatSearchResults(
  query: string,
  hits: MemexSearchHit[],
  options: FormatOptions = {},
): string {
  if (hits.length === 0) {
    return `No results for "${query}".`;
  }

  const verbose = options.verbose === true;
  const currentDocId = options.currentDocId;
  const lines: string[] = [`## Search results for "${query}" (${hits.length} hit${hits.length === 1 ? "" : "s"})`];

  for (const hit of hits) {
    const scoreSuffix = verbose ? ` (score ${hit.score.toFixed(3)})` : "";
    const selfTag =
      currentDocId && isHitOnCurrentDoc(hit, currentDocId) ? " [current doc]" : "";
    lines.push("");
    // For issues, fold the bug/todo type into the kind segment of the heading
    // so a reader can tell a bug from a todo at a glance (spec-112 t-4).
    const kindLabel =
      hit.kind === "issue" && hit.issueType ? `issue/${hit.issueType}` : hit.kind;
    lines.push(`### ${hit.path} — "${hit.title}" (${kindLabel}, ${hit.status})${selfTag}${scoreSuffix}`);
    if (hit.kind === "decision") {
      const via = hit.decisionMatchedVia ?? "fts";
      const snippet = hit.decisionSnippet ?? "";
      lines.push(`- (${via}): ${truncate(snippet, SNIPPET_MAX_CHARS)}`);
    } else if (hit.kind === "issue") {
      const via = hit.issueMatchedVia ?? "fts";
      const snippet = hit.issueSnippet ?? "";
      lines.push(`- (${via}): ${truncate(snippet, SNIPPET_MAX_CHARS)}`);
    } else {
      for (const sec of hit.matchingSections) {
        const titleSeg = sec.title ? `"${sec.title}"` : `(${sec.sectionType})`;
        const snippet = truncate((sec.content ?? "").trim(), SNIPPET_MAX_CHARS);
        lines.push(`- Section ${titleSeg} (${sec.matchedVia}):`);
        lines.push(`  > ${snippet}`);
      }
    }
  }

  return lines.join("\n");
}
