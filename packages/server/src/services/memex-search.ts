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
//
// Handhold demo specs (documents.is_demo) are excluded UNCONDITIONALLY from
// every arm (spec-178 t-11 / dec-11, ac-36). This reverses the earlier
// "searchable" posture (ac-20): a demo spec must be invisible AND inert to ⌘K
// AND to the MCP `search_memex` tool (and thereby to both in-app agents, which
// reach search only through this function). The board (SpecList) does NOT use
// searchMemex — it renders demo specs via listDocs — so no opt-in flag is
// needed here; the predicate is hard-wired into every query. The canonical
// predicate is `AND d.is_demo IS NOT TRUE` (column is NOT NULL DEFAULT false,
// but IS NOT TRUE is robust against any legacy NULL and reads as the intent).
//
// ── spec-363 sol-7: this file is now the thin ENTRY/orchestration layer. ──
// The four concerns it used to mix have moved to focused modules under
// memex-search/: retrieval (the FTS/vector SQL arms + handle lookup + slug /
// open-comment loads), ranking (the RRF merge), refs (canonical-path building),
// and formatting (the markdown renderer). This file wires them together
// (searchMemex / resolveJumpTo / resolveAssignedSpecs) and re-exports the public
// surface so every importer keeps importing the same names from the same path.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { resolveEmbeddingProvider } from "./embedding-provider.js";
import { listSpecsAssignedToUser } from "./doc-assignees.js";
import { buildDocPath, kindForDocType } from "./memex-search/refs.js";
import { mergeWithRrf } from "./memex-search/ranking.js";
import {
  attachOpenComments,
  inScopeDocTypes,
  loadMemexSlugs,
  lookupByHandle,
  resolveMaxVectorDistance,
  runDecisionFts,
  runDecisionVector,
  runIssueFts,
  runIssueVector,
  runSectionFts,
  runSectionVector,
} from "./memex-search/retrieval.js";
import type {
  DecisionRow,
  IssueRow,
  MemexSearchHit,
  SectionRow,
} from "./memex-search/types.js";

// Re-export the public surface (types + the formatter) so existing importers —
// agent/tool-specs.ts, routes/search.ts, mcp/formatters.ts, the test suites —
// keep importing the same names from "./memex-search.js" with zero edits
// (spec-363 dec-1).
export type {
  FormatOptions,
  MatchingSection,
  MemexSearchHit,
  MemexSearchKind,
  SearchMemexOptions,
  SearchStrategy,
} from "./memex-search/types.js";
export { formatSearchResults } from "./memex-search/formatting.js";

import type { SearchMemexOptions } from "./memex-search/types.js";

const HANDLE_REGEX = /^(spec|std|doc)-\d+$/i;

// spec-191: the number-jump grammar for the ⌘K Jump-to lane (dec-2). An optional
// type token + optional single `-`/space separator + a required integer, anchored
// to the whole query, case-insensitive. The token+separator form ONE optional
// group, so a lone leading separator (e.g. `-178`) does NOT parse as a bare number.
// The alternation is ordered longest-first (`spec|std|doc|s`) so `std178` resolves
// the Standard, and only a lone leading `s` (`s178`/`s-178`) takes the single-letter
// Spec short form (std-1's `s-N` vocabulary). A bare integer (no token) fans out to
// all three memex-global kinds (dec-1); a token scopes to one. `@name` assignee
// queries never match — they carry no digit in this position. Capture groups:
// [1] = optional type token, [2] = the integer.
const NUMBER_JUMP_REGEX = /^(?:(spec|std|doc|s)[\s-]?)?(\d+)$/i;

// Number-jump rows rank below an exact full-handle hit (score 1) and above the
// title-substring rows (0.5); the descending per-kind scores also keep the
// spec→std→doc order (dec-1) stable regardless of how the parallel lookups resolve.
const NUMBER_JUMP_SCORE: Record<"spec" | "std" | "doc", number> = {
  spec: 0.9,
  std: 0.8,
  doc: 0.7,
};

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
    if (direct) return attachOpenComments([direct]);
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

  const merged = mergeWithRrf(
    sectionFts as SectionRow[],
    sectionVector as SectionRow[],
    decisionFts as DecisionRow[],
    decisionVector as DecisionRow[],
    issueFts as IssueRow[],
    issueVector as IssueRow[],
    slugs,
    limit,
  );

  // spec-259 ac-12: enrich the (already-capped) result set with open-comment
  // indicators in one grouped query — batched over the result docs, never N+1.
  return attachOpenComments(merged);
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

  // 1b. Number / short-handle jump (spec-191). A bare integer — or a kind-scoped
  //     short/long form — resolves to the doc(s) carrying that number across the
  //     three memex-global kinds (spec-N / std-N / doc-N). It reuses the SAME
  //     lookupByHandle the exact-handle arm uses, so the number jump and the
  //     full-handle jump always agree on what a handle points at — no new SQL
  //     pattern, just indexed equality lookups. A bare number fans out to all
  //     three kinds, specs first (dec-1); a prefix scopes to one (s/spec → Spec,
  //     std → Standard, doc → Document — dec-2). The semantic core (searchMemex)
  //     is deliberately NOT taught numbers (dec-3): this arm is UI-only. A full
  //     handle like `spec-178` is already resolved by the exact-handle arm above
  //     and deduped here via seenDocIds, so it is never listed twice; visibility
  //     (archived + is_demo excluded, drafts included) is inherited from
  //     lookupByHandle unchanged.
  const numberMatch = NUMBER_JUMP_REGEX.exec(trimmed);
  if (numberMatch) {
    const token = numberMatch[1]?.toLowerCase();
    const n = Number.parseInt(numberMatch[2], 10);
    // token → ordered candidate kinds. No token → all three, specs first (dec-1).
    // `s` is the single-letter short form for a Spec (std-1's `s-N` vocabulary).
    const kinds: ReadonlyArray<"spec" | "std" | "doc"> =
      token === undefined
        ? ["spec", "std", "doc"]
        : token === "std"
          ? ["std"]
          : token === "doc"
            ? ["doc"]
            : ["spec"]; // "s" | "spec"
    // Resolve the (≤3) candidate handles in parallel, then push in kind order so
    // the spec→std→doc ranking is deterministic regardless of resolution timing.
    const resolved = await Promise.all(
      kinds.map((kind) => lookupByHandle(memexId, slugs, `${kind}-${n}`, false)),
    );
    kinds.forEach((kind, i) => {
      const hit = resolved[i];
      if (hit && !seenDocIds.has(hit.id)) {
        seenDocIds.add(hit.id);
        hits.push({ ...hit, score: NUMBER_JUMP_SCORE[kind] });
      }
    });
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
      AND d.is_demo IS NOT TRUE
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
      // Navigation-only lane (⌘K jump tier) — WHO/WHEN isn't rendered here
      // (spec-285 dec-3 defers palette metadata), so leave them null.
      authorName: null,
      lastUpdatedAt: null,
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

  // spec-178 t-11 / dec-11 (ac-36): a demo spec must not surface in the
  // assigned lane either. listSpecsAssignedToUser (doc-assignees.ts) excludes
  // archived/paused but not is_demo and doesn't project the flag, so resolve the
  // demo doc ids for this memex in one batched read and skip them below. The
  // demo set is tiny (one per phase), so this is a cheap single round-trip.
  const demoRows = (await db.execute(sql`
    SELECT id FROM documents
    WHERE memex_id = ${memexId} AND is_demo IS TRUE
  `)) as unknown as { id: string }[];
  const demoDocIds = new Set(demoRows.map((r) => r.id));

  const hits: MemexSearchHit[] = [];
  const seenDocIds = new Set<string>();
  for (const userId of userIds) {
    const rows = await listSpecsAssignedToUser(memexId, userId);
    for (const r of rows) {
      if (demoDocIds.has(r.docId)) continue;
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
        // Navigation-only lane — WHO/WHEN unrendered here (spec-285 dec-3).
        authorName: null,
        lastUpdatedAt: null,
        matchingSections: [],
      });
    }
  }
  return hits;
}
