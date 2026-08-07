// Shared types for the memex-search modules (spec-363 sol-7: god-module split).
// Public types (SearchStrategy, MemexSearchKind, MatchingSection, MemexSearchHit,
// SearchMemexOptions, FormatOptions) are re-exported verbatim from the
// memex-search.ts entry, so importers keep importing the same names from the same
// path. The row interfaces are internal to the retrieval/ranking modules but live
// here so retrieval (which builds them) and ranking (which consumes them) agree on
// one definition. Moved verbatim from the original memex-search.ts.

import type { EmbeddingProvider } from "../embedding-provider.js";

export type SearchStrategy = "handle" | "fts" | "vector";

// Per b-34 D-2: phase-1 scope. `kind` is optional — omit to search every
// kind. Tasks, comments, execution-plan sections deferred (easy to add as
// additional kinds later). Issues (spec-112 t-4) join the decision arm as a
// second non-section kind — same RRF FTS+vector machinery, no new search
// infra (s-4): they ride their own table's title/body + embedding column.
export type MemexSearchKind = "spec" | "standard" | "document" | "decision" | "issue";

export interface MatchingSection {
  id: string;
  sectionType: string;
  title: string | null;
  content: string;
  /** Which search method surfaced this section first. */
  matchedVia: SearchStrategy;
  /** WHO — best-effort display name of who last touched THIS section (spec-259
   *  ac-9). Carried per-section so a multi-section doc hit surfaces each
   *  matched section's own creator, not just the doc-level latest. Same SQL
   *  COALESCE(actor_name, users.name, users.email) resolution as the doc-level
   *  WHO. null when nothing resolved. Wire/structured value — kept absolute. */
  authorName: string | null;
  /** WHEN — ISO-8601 last-modified of THIS section (spec-259 ac-9). Absolute
   *  ISO on the structured object; rendered relative via timeAgo(). */
  lastUpdatedAt: string | null;
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
  /** WHO — best-effort display name of who authored / last touched this hit
   *  (spec-285 dec-1). For decision/section hits this is the denormalised
   *  std-32 `actor_name` where present (rename-proof); for document and issue
   *  hits, the `created_by_user_id` resolved to `users.name ?? users.email`.
   *  null when nothing resolved (a system write, a deleted user, a legacy
   *  unattributed row). Navigation-only lanes (jump / assigned) leave it null. */
  authorName: string | null;
  /** WHEN — ISO-8601 timestamp of when this hit was last changed (spec-285
   *  dec-2): the row's last-modified where it has one (`doc_sections`/`issues`
   *  `updated_at`), falling back to `created_at` where it does not (decisions
   *  carry no `updated_at`). null only when no timestamp was selected
   *  (navigation-only lanes). */
  lastUpdatedAt: string | null;
  /** Open (unresolved) comments anchored on this hit's doc (spec-259 ac-12). A
   *  lightweight indicator only — count + oldest open comment's age — never the
   *  comment content. `oldestCreatedAt` is absolute ISO on the structured
   *  object; rendered relative via timeAgo(). Omitted (undefined) when the hit
   *  has zero open comments, so the formatter renders no indicator line. */
  openComments?: { count: number; oldestCreatedAt: string };
  /** spec-521 dec-7 (ac-9) — WHEN the hit's CONTENT was last meaningfully changed,
   *  which is not the same question as the WHO/WHEN byline's `lastUpdatedAt`.
   *
   *  The point of this field is that a merely-stale Spec currently reads identically
   *  to a fresh one. Supersession catches the case where somebody recorded the
   *  replacement; recency catches the far commoner case where nobody did.
   *
   *  Per-kind source, per ac-9:
   *    - decision hits → LAST-RESOLVED (`decisions.resolved_at`)
   *    - spec / standard / document / issue hits → LAST-UPDATED
   *  `recencyVerb` names which, so the rendered label never claims a decision was
   *  "resolved" when it is still open. Absolute ISO here; rendered via timeAgo(). */
  recencyAt: string | null;
  recencyVerb: "resolved" | "updated";
  /** spec-521 dec-5 (ac-7) — the successor's handle when this hit's OWNING Spec has
   *  been superseded, else null. Enriched after the merge in one bulk lookup rather
   *  than selected in all seven retrieval tiers. */
  supersededByHandle?: string | null;
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

export interface SectionRow {
  section_id: string;
  doc_id: string;
  section_type: string;
  section_title: string | null;
  section_content: string;
  doc_handle: string;
  doc_title: string;
  doc_status: string;
  doc_type: string;
  // spec-285: WHO/WHEN. `author_name` is computed in SQL — the section's
  // denormalised actor_name (std-32) preferred, else the parent doc's resolved
  // creator. `updated_at` is the section's own last-modified.
  author_name: string | null;
  updated_at: string | Date;
  rank?: number; // FTS ts_rank
  distance?: number; // vector cosine distance
}

export interface DecisionRow {
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
  // spec-285: WHO/WHEN. `author_name` = decision's denormalised actor_name
  // (std-32) preferred, else the actor_user_id resolved to a user. `created_at`
  // is the only timestamp decisions carry (no updated_at — dec-2 fallback).
  author_name: string | null;
  created_at: string | Date;
  // spec-521 dec-7 (ac-9): the decision's LAST-RESOLVED timestamp — the one the
  // recency indicator uses for a decision hit, because "how old is this decision"
  // means "when was this settled", not "when was the row first written". NULL for an
  // unresolved decision, which falls back to created_at and is labelled `updated`
  // rather than claiming a resolution that never happened.
  resolved_at: string | Date | null;
  rank?: number;
  distance?: number;
}

export interface IssueRow {
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
  // spec-285: WHO/WHEN. Issues carry no actor_name (std-32 hasn't reached the
  // issues table) — `author_name` is the created_by_user_id resolved to a user.
  // `updated_at` is the issue's own last-modified.
  author_name: string | null;
  updated_at: string | Date;
  rank?: number;
  distance?: number;
}

// Resolved Memex slug parts — needed to build canonical paths.
export interface MemexSlugs {
  namespace_slug: string;
  memex_slug: string;
}

// Row shape for lookupByHandle's documents⨝sections⨝users projection (spec-285).
export interface HandleRow {
  section_id: string;
  section_type: string;
  section_title: string | null;
  section_content: string;
  section_actor_name: string | null;
  section_updated_at: string | Date | null;
  doc_id: string;
  doc_handle: string;
  doc_title: string;
  doc_status: string;
  doc_type: string;
  doc_created_at: string | Date | null;
  doc_status_changed_at: string | Date | null;
  doc_author_name: string | null;
  doc_author_email: string | null;
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
  /** Injectable "now" for relative-age rendering (spec-259 dec-5). Tests pass a
   *  fixed clock so `timeAgo()` output is deterministic; production omits it and
   *  the helpers default to the real wall clock. */
  now?: Date;
}
