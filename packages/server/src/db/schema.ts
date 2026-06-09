import { pgTable, text, uuid, timestamp, integer, unique, uniqueIndex, check, primaryKey, jsonb, boolean, index, customType, doublePrecision } from "drizzle-orm/pg-core";
import { relations, type InferSelectModel, type InferInsertModel, sql } from "drizzle-orm";
import type { CommentAction, CommentAudience } from "../types/roles.js";

// Postgres types that aren't first-class in Drizzle:
// - tsvector: full-text-search vector, generated from files.content
// - vector(N): pgvector embedding column
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
});

// BYTEA — raw binary storage. Used for envelope-encrypted secrets (user_slack_tokens
// per doc-23 D-2). Driver returns Buffer; we expose Uint8Array to callers so the
// service layer stays Node-Buffer-free.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value);
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
});

// Postgres INET — IPv4 / IPv6 addresses with range-query support (CIDR ops).
// Used by mcp_sessions.ip_address. Driver returns the string form; we accept
// the same string going in (caller is responsible for handing us a valid IP,
// which in our case comes straight from X-Forwarded-For).
const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});

// Forward-declared so child tables can reference memexes.id. The actual memexes table
// definition lives later in this file (multi-tenancy section). All resource tables carry
// memex_id directly (denormalised for fast queries + simple isolation).
//
// Per std-1 / dec-9 of doc-15, the legacy `accounts` table is split into three peer
// concepts: namespaces (URL slug), orgs (billing/membership), memexes (workspace).
// Tenancy-scoped resource rows belong to a memex.
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  memexId: uuid("memex_id").notNull(),
  // Handle is per-memex unique (not globally), so each Memex has its own doc-1, doc-2, ...
  handle: text("handle").notNull(),
  title: text("title").notNull(),
  // Default is `"document"` — the generic catch-all docType. Callers that need
  // a specific shape (spec, standard, execution_plan) MUST pass docType
  // explicitly. The `"spec"` value was the original default (retired in doc-21
  // Cluster C in favour of `"document"`); it returned in b-105 as the docType
  // for what used to be called Briefs (Brief → Spec rename, see 0063).
  docType: text("doc_type").notNull().default("document"),
  status: text("status").notNull().default("draft"),
  // Spec lineage (dec-11 of doc-12): when a Spec is promoted into multiple child
  // Specs, each child carries its parent's id here. Self-FK, ON DELETE SET NULL — keep
  // children if a parent is removed.
  parentDocId: uuid("parent_doc_id"),
  // Set by createDocDraft to whoever's logged in. Nullable for legacy rows; React UI shows
  // "Unknown" when null. ON DELETE SET NULL via the FK so removing a user doesn't
  // cascade-delete docs.
  createdByUserId: uuid("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
  // NULL = active, set = archived. Orthogonal to status so the Spec retains its
  // kanban lane when unarchived. All list/get queries filter out archived rows by
  // default — pass includeArchived to opt in.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  // NULL = active, set = paused. Spec-only lifecycle flag — paused Specs stop
  // receiving agent work but stay visible in their kanban lane.
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  // Last time the Spec narrative was consolidated by the agent. NULL = never
  // consolidated. Spec-only.
  narrativeLastConsolidatedAt: timestamp("narrative_last_consolidated_at", { withTimezone: true }),
  // Handhold onboarding demo flag (spec-178). When true, this document is one of
  // the five frozen copies of the canonical ⌘K-search Spec (spec-64) seeded into a
  // personal Memex to walk a new user through the spec lifecycle. Demo docs render a
  // DEMO badge + a per-phase value banner, suppress handle auto-linking, are excluded
  // from ⌘K/search and every agent surface (dec-11; only the board REST list/get still
  // returns them), and are excluded from Pulse/usage analytics. Reset (POST
  // .../handhold/reset) hard-deletes all is_demo docs in the memex + their seeded
  // test-event emissions and re-seeds from handhold-demo.fixture.ts.
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  unique("documents_memex_id_handle_unique").on(table.memexId, table.handle),
  index("documents_memex_id_idx").on(table.memexId),
  // Per dec-3 of doc-10 the Spec rename (`review`→`plan`, `implementation`→`build`,
  // plus new `verify`) applies to docType='spec' rows only. Non-Spec docTypes keep
  // the legacy values, so this CHECK is the union of old + new and stays that way.
  // spec-181 (dec-2): the second phase renamed `plan`→`specify` (pipeline is now
  // draft → specify → build → verify → done) — migration 0078 flips the rows and
  // swaps 'specify' for 'plan' here. The legacy values (draft/review/implementation/
  // done/approved) stay because execution-plan rows still carry them.
  check("documents_status_valid", sql`${table.status} IN ('draft', 'review', 'implementation', 'done', 'approved', 'specify', 'build', 'verify')`),
]);

export const docSections = pgTable(
  "doc_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sectionType: text("section_type").notNull(),
    title: text("title"),
    // spec-106 (ac-10): nullable free-text metadata describing the section's
    // purpose. Travels everywhere section data does (get_doc/list_docs/section
    // responses) and is writable via update_section/add_section. NULL is the
    // "no description" sentinel; no backfill (migration 0067).
    description: text("description"),
    content: text("content").notNull(),
    // spec-150 (dec-1): the section's non-clause connective prose. NULL = the
    // section is not decomposed and `content` is authoritative (every non-standard
    // doc, and any standard section pre-migration). When clauses exist, `content`
    // is the derived byte-identical projection of (preamble + composed clauses), so
    // the embed / FTS / export / admin read paths stay unchanged. Nullable, no
    // backfill — mirrors the `description` convention so fixtures need not set it.
    preamble: text("preamble"),
    // spec-150 (dec-2): `seq` is the stable, ALLOCATE-ONCE IDENTITY that backs the
    // `s-N` ref. Minted as MAX(seq)+1 and NEVER resequenced (a deleted seq is frozen,
    // never reused), so every existing `s-N` URL keeps resolving forever. The display
    // order lives in `position` (below), NOT here. Do not use `seq` for ordering.
    seq: integer("seq").notNull(),
    // spec-150 (dec-2): the DISPLAY order — what renders as "1, 2, 3". Backfilled to
    // `seq` at migration (0072) so the two start identical, then diverge (resequenced
    // on delete, reorderable later). `position` may move freely; identity never does.
    position: integer("position").notNull(),
    // Soft-delete lifecycle (spec-107 dec-2), mirroring the decisions precedent
    // (b-97). `delete_section` flips status to 'deleted' and captures the prior
    // status in `previousStatus` so the update path can restore it losslessly.
    // All read paths (get_doc, lists, render, FTS + vector search) filter
    // `status != 'deleted'` (NULL treated as active for the migration window).
    status: text("status").notNull().default("active"),
    previousStatus: text("previous_status"),
    // NOTE: `content_tsv` (tsvector, generated always as
    // `to_tsvector('english', COALESCE(content, ''))`) lives in the DB but is
    // intentionally NOT modelled here — adding it as a Drizzle column makes
    // the field required on `InferSelectModel`, which would force every
    // DocSection test fixture in the project to set it. The FTS query uses
    // raw `sql\`content_tsv @@ ...\`` and the GIN index
    // (`doc_sections_content_tsv_idx`) is defined in
    // 0027_v2_deferral_fixes.sql.
    //
    // Same convention applies to the memex-embeddings columns added in
    // 0031_add_doc_section_embeddings.sql: `embedding vector(1536)`,
    // `embedding_model text`, `embedding_updated_at timestamptz`. These are
    // populated only for sections of docType='standard' by
    // services/memex-embeddings.ts (raw SQL via `sql\`embedding = …\``)
    // and read via raw SQL in services/memex-search.ts. Keeping them out
    // of the Drizzle schema preserves the InferSelectModel shape that every
    // existing DocSection fixture in the project expects.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // `seq` is the allocate-once identity (spec-150 dec-2): minted as MAX(seq)+1 and
    // never reused, so a deleted section's frozen seq can't collide with a live one.
    // (Partial index retained from spec-107; the allocate-once allocator now provides
    // identity uniqueness. The resequencing display order moved to `position`.)
    uniqueIndex("doc_sections_doc_seq_unique")
      .on(table.docId, table.seq)
      .where(sql`status <> 'deleted'`),
    unique("doc_sections_doc_id_section_type_unique").on(table.docId, table.sectionType),
  ]
);

// spec-150 t-2: standard clauses are first-class rows (dec-1) — peers of `acs`,
// each addressable as the flat `std-N/clauses/cl-K` ref. A DEDICATED table, not
// doc_sections rows: the embed + FTS pipelines key on doc_sections, so per-clause
// rows there would change the search corpus and break transparency (dec-1 grounding).
//
// Identity vs order (dec-2): `seq` is allocate-once per standard (the `cl-N` ref
// handle) and is NEVER resequenced — gaps are tolerated, exactly like `acs`. A plain
// UNIQUE(doc_id, seq) suffices (no partial index, unlike doc_sections which
// resequences). `position` is the separate, freely-resequencing ordering used only
// to compose/render clauses within their section.
export const standardClauses = pgTable(
  "standard_clauses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => docSections.id, { onDelete: "cascade" }),
    // Allocate-once per-standard handle → the `cl-N` canonical-ref segment. Never
    // resequenced (dec-2): delete/insert leaves every other clause's seq untouched.
    seq: integer("seq").notNull(),
    // Ordering of the clause WITHIN its section, for composition + display only.
    // May resequence freely; distinct from `seq`, which is the stable identity.
    position: integer("position").notNull(),
    body: text("body").notNull(),
    // Soft-delete lifecycle, mirroring doc_sections / decisions.
    status: text("status").notNull().default("active"),
    previousStatus: text("previous_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Allocate-once seq → plain unique is enough: a deleted seq is never reused, so
    // soft-deleted rows can't collide with a live insert (no resequencing needed).
    unique("standard_clauses_doc_seq_unique").on(table.docId, table.seq),
    index("standard_clauses_doc_id_idx").on(table.docId),
    index("standard_clauses_section_id_idx").on(table.sectionId),
    index("standard_clauses_memex_id_idx").on(table.memexId),
  ],
);

// spec-179 (dec-3): materialized handle-mentions parsed out of standard-clause
// bodies (and, via the one-time 0076 backfill, legacy section preambles). One
// row per (source, target_kind, target_handle) — the structured form of "this
// clause cites std-2" that the standards-graph endpoint joins instead of
// parsing prose at request time. Maintained inside the clause mutation
// transactions (services/clause-refs.ts syncClauseRefsTx); preamble edits do
// NOT resync (preambles are frozen connective prose on legacy decomposed
// sections — see services/clause-refs.ts header).
//
// `target_doc_id` is resolved memex-scoped for doc-level handles (std-N /
// spec-N / legacy b-N / doc-N) and NULL for doc-relative kinds (dec-N, cl-N)
// or unresolvable handles — a NULL target yields no graph edge (ac-12, never a
// cross-memex one). The partial unique indexes + the one-source CHECK live in
// the hand-written migration (drizzle/0076_add_clause_refs.sql); the index()
// entries below keep schema.ts honest about which columns are indexed.
export const clauseRefs = pgTable(
  "clause_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    // Exactly one of the two sources is set (CHECK in 0076): a live clause ref
    // (write-path maintained) or a legacy preamble ref (backfill-only).
    sourceClauseId: uuid("source_clause_id").references(() => standardClauses.id, {
      onDelete: "cascade",
    }),
    sourceSectionId: uuid("source_section_id").references(() => docSections.id, {
      onDelete: "cascade",
    }),
    sourceDocId: uuid("source_doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").notNull(),
    targetHandle: text("target_handle").notNull(),
    targetDocId: uuid("target_doc_id").references(() => documents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("clause_refs_memex_id_idx").on(table.memexId),
    index("clause_refs_source_doc_id_idx").on(table.sourceDocId),
    index("clause_refs_target_doc_id_idx").on(table.targetDocId),
    check(
      "clause_refs_kind_valid",
      sql`${table.targetKind} IN ('standard', 'spec', 'document', 'decision', 'clause')`
    ),
  ]
);

export const docComments = pgTable(
  "doc_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    // Per-doc seq scope. Comments transitively belong to a doc through their
    // section / decision / task target; doc_id is denormalised onto the row so
    // the `(doc_id, seq)` allocator can mint per-doc `c-N` handles in one
    // index lookup without a join. Backfilled by 0046 from the section/decision/task FK.
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    sectionId: uuid("section_id")
      .references(() => docSections.id, { onDelete: "cascade" }),
    decisionId: uuid("decision_id")
      .references(() => decisions.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorName: text("author_name").notNull(),
    // Attribution: author's user/namespace for external-comment rendering. external is
    // computed at render time as `author_namespace_id != memex.namespace_id` (the doc's
    // memex's namespace). Nullable for legacy comments without attribution.
    authorUserId: uuid("author_user_id"),
    authorNamespaceId: uuid("author_namespace_id"),
    content: text("content").notNull(),
    // Typed-comment columns (Section 7 of doc-10):
    //   commentType — discussion (default, human freeform) | plan | progress | issue |
    //                 deferred | cross_reference | question | review | readiness_check |
    //                 approval | plan_revision | drift
    //   source      — human (default) | agent
    //   referenceType + referenceId — populated only for cross_reference comments to point
    //                                 at another task / spec / decision / standard.
    commentType: text("comment_type").notNull().default("discussion"),
    source: text("source").notNull().default("human"),
    // doc-26 t-4: structured FK targets for cross_reference comments. Replace the
    // opaque (referenceType, referenceId) text pair with one nullable FK per kind.
    // Rendering joins through these to fetch the entity's CURRENT handle, so the
    // stored value survives any future handle scheme change without a content
    // sweep. At most one of the four may be NOT NULL on a single comment
    // (CHECK constraint enforced for commentType='cross_reference').
    referenceBriefId: uuid("reference_brief_id").references(() => documents.id, { onDelete: "cascade" }),
    referenceStandardId: uuid("reference_standard_id").references(() => documents.id, { onDelete: "cascade" }),
    referenceDecisionId: uuid("reference_decision_id").references(() => decisions.id, { onDelete: "cascade" }),
    referenceTaskId: uuid("reference_task_id").references(() => tasks.id, { onDelete: "cascade" }),
    resolution: text("resolution"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // spec-100 (geo-comments). The marker glyph in the section source is the
    // comment's own `c-{seq}` handle (`[^c-{seq}]`, dec-1) — derivable from
    // `seq`, so no marker-id column is stored.
    //   anchorSnippet — snapshot of surrounding text at creation (dec-4).
    //                   NULL => floating comment (the historic behaviour).
    //   audience      — reserved for v1+ attention routing; v0 writes "all".
    //   actions       — system-authored buttons (Address/Dismiss); NULL on
    //                   human comments. `kind` is an open string (spec-100 §7).
    anchorSnippet: text("anchor_snippet"),
    audience: jsonb("audience").$type<CommentAudience>().notNull().default("all"),
    actions: jsonb("actions").$type<CommentAction[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "doc_comments_exactly_one_target",
      sql`(CASE WHEN ${table.sectionId} IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN ${table.decisionId} IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN ${table.taskId} IS NOT NULL THEN 1 ELSE 0 END) = 1`
    ),
    check(
      "doc_comments_comment_type_valid",
      sql`${table.commentType} IN ('discussion', 'plan', 'progress', 'issue', 'deferred', 'cross_reference', 'question', 'review', 'readiness_check', 'approval', 'plan_revision', 'drift')`
    ),
    check(
      "doc_comments_source_valid",
      sql`${table.source} IN ('human', 'agent')`
    ),
    // doc-26 t-4: cross_reference comments must point at exactly one target
    // kind (or zero, for legacy rows whose backfill couldn't resolve a
    // handle). Service layer enforces "exactly one" on writes.
    check(
      "doc_comments_cross_reference_target",
      sql`${table.commentType} <> 'cross_reference' OR (
        (CASE WHEN ${table.referenceBriefId}    IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN ${table.referenceStandardId} IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN ${table.referenceDecisionId} IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN ${table.referenceTaskId}     IS NOT NULL THEN 1 ELSE 0 END
        ) <= 1
      )`
    ),
    index("doc_comments_memex_id_idx").on(table.memexId),
    // Drift Inbox query path (services/drift-inbox.ts): per-memex stream of open
    // drift + plan_revision comments, paged by (created_at DESC, id DESC). The
    // multicolumn index covers the WHERE + ORDER BY without a sort step.
    index("doc_comments_drift_inbox_idx").on(
      table.memexId,
      table.commentType,
      table.createdAt,
      table.id,
    ),
    // Per-doc seq scope (b-36 T-2). Backfilled deterministically by
    // ROW_NUMBER() OVER (PARTITION BY doc_id ORDER BY created_at, id).
    unique("doc_comments_doc_seq_unique").on(table.docId, table.seq),
  ]
);

// ══════════════════════════════════════
// Decisions
// ══════════════════════════════════════

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    context: text("context"),
    status: text("status").notNull().default("open"),
    // Structured options (dec-8): Array<{ label, trade_offs }>. Null until populated;
    // resolution narrative still lives in `resolution`. `chosenOptionIndex` is set when
    // status moves to 'resolved' from a multi-option candidate decision.
    options: jsonb("options"),
    chosenOptionIndex: integer("chosen_option_index"),
    // Provenance: 'human' (REST UI / direct service call) or 'agent' (per-turn extraction
    // via proposeDecision). NOT NULL DEFAULT 'human' so every legacy row backfills.
    source: text("source").notNull().default("human"),
    resolution: text("resolution"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // Captures the status held at the moment delete_decision was called (b-97).
    // Non-null exactly when `status='deleted'`; cleared on restore via
    // update_decision. Lets the restore path return the decision to its prior
    // state without the caller having to remember it.
    previousStatus: text("previous_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("decisions_doc_id_seq_unique").on(table.docId, table.seq),
    index("decisions_memex_id_idx").on(table.memexId),
    check(
      "decisions_status_valid",
      sql`${table.status} IN ('open', 'resolved', 'candidate', 'rejected', 'deleted')`
    ),
    check(
      "decisions_source_valid",
      sql`${table.source} IN ('human', 'agent')`
    ),
  ]
);

// ══════════════════════════════════════
// Tasks
// ══════════════════════════════════════

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria").notNull().default([]),
    sectionRef: text("section_ref"),
    status: text("status").notNull().default("not_started"),
    // Per dec-6 of doc-10: the task's execution plan is itself a document
    // (docType='execution_plan') referenced via this nullable FK. ON DELETE SET NULL
    // keeps the task if the plan doc is deleted.
    executionPlanDocId: uuid("execution_plan_doc_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("tasks_doc_id_seq_unique").on(table.docId, table.seq),
    index("tasks_memex_id_idx").on(table.memexId),
  ]
);

// ══════════════════════════════════════
// Dependency Edges
// ══════════════════════════════════════

// Task blocked by an unresolved decision. The (task, decision) pair is allowed to span
// documents — the intra-doc constraint is NOT enforced at the schema layer.
export const decisionDeps = pgTable(
  "decision_deps",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => decisions.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.decisionId] }),
  ]
);

// Task depends on another task.
export const taskDeps = pgTable(
  "task_deps",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnId: uuid("depends_on_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOnId] }),
    check("no_self_dep", sql`${table.taskId} != ${table.dependsOnId}`),
  ]
);

// ══════════════════════════════════════
// Acceptance Criteria (feat-ac-spike, V0.0.1)
// ══════════════════════════════════════
//
// An AC is a forward-facing testable assertion about what the system must do.
// Two flavours: 'scope' (manager-authored, plain-English outcome commitments
// that travel with the Brief body) and 'implementation' (agent-spawned from
// resolved Decisions, technical, AI-coder territory). Same shape, different
// lifecycles. See docs/ac-primitive-hypothesis.md for the full thesis.
//
// Tenancy: every AC belongs to exactly one Brief via brief_id (NOT NULL,
// ON DELETE CASCADE). Tenancy and direct parentage are separate concepts —
// direct parentage lives in ac_parent_links below.
export const acs = pgTable(
  "acs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    briefId: uuid("brief_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    statement: text("statement").notNull(),
    status: text("status").notNull().default("active"),
    // spec-188 dec-1/dec-2: manual verification acceptance — the audited human
    // override for ACs that can't be exercised by a digital test. Both NULL =
    // no acceptance. `accepted_by` is a display snapshot (user.name ?? email),
    // same posture as test_events.actor: attribution survives user deletion.
    // The acceptance is an OVERLAY on the test-derived verification state —
    // failing evidence suppresses it (derivation in services/acs.ts), it is
    // never auto-deleted; un-accept nulls both columns.
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("acs_brief_id_seq_unique").on(table.briefId, table.seq),
    index("acs_memex_id_idx").on(table.memexId),
    index("acs_brief_id_idx").on(table.briefId),
    check(
      "acs_kind_valid",
      sql`${table.kind} IN ('scope', 'implementation')`,
    ),
    check(
      "acs_status_valid",
      sql`${table.status} IN ('proposed', 'active', 'rejected', 'superseded')`,
    ),
  ]
);

// Direct parentage for ACs. Polymorphic: parent_kind tells you what parent_id
// references. 'brief' → documents.id (typically Scope ACs); 'decision' →
// decisions.id (typically Implementation ACs). Many-to-many: an AC can have
// multiple parents (rare but allowed for cross-cutting Implementation ACs).
//
// Blast-radius cascades follow THIS table, not the acs.brief_id tenancy
// column. The tenancy column is for scoping queries only; the cascade question
// "what's affected if this Decision is reopened?" is answered by joining
// through ac_parent_links.
export const acParentLinks = pgTable(
  "ac_parent_links",
  {
    acId: uuid("ac_id")
      .notNull()
      .references(() => acs.id, { onDelete: "cascade" }),
    parentKind: text("parent_kind").notNull(),
    parentId: uuid("parent_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.acId, table.parentKind, table.parentId] }),
    index("ac_parent_links_parent_idx").on(table.parentKind, table.parentId),
    check(
      // spec-112 ac-19: 'issue' joins 'brief' / 'decision' so an AC spawned to
      // verify an Issue's expected behaviour can be parented to that Issue
      // (parent_kind='issue', parent_id → issues.id). 'brief' is NOT renamed —
      // it remains the legacy spec-105 carve-out value.
      "ac_parent_links_kind_valid",
      sql`${table.parentKind} IN ('brief', 'decision', 'issue')`,
    ),
  ]
);

// ══════════════════════════════════════
// Issues (spec-112)
// ══════════════════════════════════════
//
// An Issue is a bug or todo registered against a Spec as a whole — it does NOT
// anchor to a section/decision/task (unlike doc_comments). Modelled on acs/tasks:
// tenancy on memex_id (NOT NULL, denormalised), parentage + per-Spec handle space
// via doc_id → documents.id ON DELETE CASCADE (deleting a Spec deletes its Issues,
// ac-9), and a UNIQUE(doc_id, seq) allocator minting `issue-N` handles independent of
// the ac/task/comment/decision seq spaces on the same Spec (ac-10).
//
// "No new infrastructure" (s-4): the docId column uses the GENERIC name — NOT the
// legacy `brief_id` that acs carries (that name is the spec-105 carve-out and stays
// untouched). Issue writes flow through mutate() with entity:"issue" and emit on the
// unified bus (std-8, ac-11). The embedding triplet (added in 0068, kept out of the
// Drizzle schema like doc_sections/decisions) feeds the same RRF search path (ac-13).
//
// Link columns for the converted target (ac-20/ac-21/ac-23/ac-24): both nullable.
// `satisfyingTaskId` → the Task an issue→task conversion produced (ON DELETE SET NULL
// so deleting the Task doesn't cascade-delete the Issue — the kick-up path in ac-31
// reverts the Issue to 'open' instead). `promotedDocId` → the child Spec a promotion
// produced (ON DELETE SET NULL, same reasoning).
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    // bug | todo (ac-3 / ac-30). Bugs close the bug→failing-AC→green-AC→resolved
    // loop; todos are the human-level backlog (ac-29).
    type: text("type").notNull(),
    // Free-text severity (e.g. low/medium/high/critical) — left unconstrained at the
    // DB layer; the service surface owns the vocabulary (ac-3).
    severity: text("severity"),
    status: text("status").notNull().default("open"),
    // 'human' (React UI direct entry / human via MCP) or 'agent' (coding agent or
    // React in-app agent), mirroring decisions.source / doc_comments.source.
    source: text("source").notNull().default("human"),
    // Converted-target links (nullable). See header.
    satisfyingTaskId: uuid("satisfying_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    promotedDocId: uuid("promoted_doc_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("issues_doc_id_seq_unique").on(table.docId, table.seq),
    index("issues_memex_id_idx").on(table.memexId),
    index("issues_doc_id_idx").on(table.docId),
    check(
      "issues_type_valid",
      sql`${table.type} IN ('bug', 'todo')`,
    ),
    // ac-16: exactly this set, nothing else.
    check(
      "issues_status_valid",
      sql`${table.status} IN ('open', 'converted', 'resolved', 'wont_fix')`,
    ),
    check(
      "issues_source_valid",
      sql`${table.source} IN ('human', 'agent')`,
    ),
  ]
);

// Many-to-many between Tasks and ACs. A Task can contribute to multiple ACs;
// an AC can have multiple Tasks satisfying it (e.g. front-end + back-end +
// migration tasks all contributing to "system uses Redis"). The Task primitive
// itself stays under the Brief — the existing tasks.docId FK is unchanged.
export const taskSatisfiesAc = pgTable(
  "task_satisfies_ac",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    acId: uuid("ac_id")
      .notNull()
      .references(() => acs.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.acId] }),
    index("task_satisfies_ac_ac_id_idx").on(table.acId),
  ]
);

// Test event emissions tagged with AC handle. Append-only log of pass/fail
// events posted to POST /api/test-events by tests in the codebase. The
// workspace computes AC verification status from the latest event per
// (ac_uid, test_identifier).
//
// Deliberately no `tests` primitive: the codebase is the source of truth for
// tests. ac_uid is a free-text reference (typically the AC handle like 'ac-12'
// or a canonical ref) that the workspace resolves at query time, not a FK —
// keeping it text-shaped lets renamed or restructured ACs degrade gracefully
// instead of silently dropping rows. test_identifier is whatever the test
// passes (typically file path + function name) so emissions can be grouped by
// test for flakiness analysis.
export const testEvents = pgTable(
  "test_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    acUid: text("ac_uid").notNull(),
    status: text("status").notNull(),
    testIdentifier: text("test_identifier"),
    durationMs: integer("duration_ms"),
    commitSha: text("commit_sha"),
    runId: text("run_id"),
    // Actor — WHO emitted this event (spec-115 dec-6, spec-122 activity
    // contract). First-class column, not nested in metadata, so the Pulse
    // activity view can UNION on actor across every activity-bearing
    // table without going through metadata->>'actor'. Nullable: callers
    // running outside a known env (no GITHUB_ACTOR, no USER, etc.) omit
    // the field and it lands as NULL. The helper auto-populates from a
    // documented env-var fallback chain; consumers can also post it
    // explicitly. A `metadata.actor` key (legacy hand-rolled wire format)
    // is accepted opaquely as metadata but NOT promoted into this column.
    actor: text("actor"),
    // Hidden flag (spec-115 v0.1.0). When true, the event is stored but
    // excluded from the AC's displayed verification badge calculation.
    // Audit trail intact; "latest emission wins" logic skips hidden rows.
    hidden: boolean("hidden").notNull().default(false),
    // Extensible metadata bag (spec-115 v0.1.0). Surfaced in the AC matrix
    // tooltip in the admin UI. Well-known keys (actor, branch, commit, host,
    // run_id, run_url) render specially; unknown keys render as plain
    // key-value pairs. Server-side caps (4KB total, 32 keys, 256-char
    // values) enforced at the route; oversized keys are dropped and named
    // in the X-Memex-Warning response header. Stored as JSONB.
    metadata: jsonb("metadata").$type<Record<string, string>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("test_events_ac_uid_created_at_idx").on(table.acUid, table.createdAt),
    index("test_events_test_identifier_idx").on(table.testIdentifier, table.createdAt),
    check(
      "test_events_status_valid",
      sql`${table.status} IN ('pass', 'fail', 'error')`,
    ),
  ]
);

// ══════════════════════════════════════
// Test-event latest summary (spec-162)
// ══════════════════════════════════════
//
// An incrementally-maintained "latest event per (ac_uid, test_identifier)"
// rollup over `test_events`. The board's acHealth read (aggregateAcHealthForBriefs)
// and the per-Spec AC tab (listAcsForBriefWithVerification) read from HERE
// instead of scanning the whole append-only `test_events` log, making the read
// O(active AC×test pairs) rather than O(total history) (spec-162 ac-1).
//
// Maintenance is app-level at the two — and only two — sites that mutate
// `test_events` (spec-162 dec-1): an upsert on emission (POST /api/test-events)
// and a row-delete on discontinue (discontinueTestEventsForAc), each inside a
// db.transaction() so the log and this derived summary can't diverge on a crash.
// See services/test-event-latest.ts. The `test_events` log itself is unchanged
// and remains the audit trail + source for the history views (matrix, sparkline).
//
// `test_identifier` is NOT NULL DEFAULT '' (spec-162 dec-2): a Postgres PK can't
// contain NULL, and the empty string mirrors the runtime key the JS reduce used
// (ev.testIdentifier ?? "") so summary and prior behaviour agree by construction.
// Hidden events (spec-115) never enter this table — they're excluded from badge
// calculation, so the upsert skips them.
export const testEventLatest = pgTable(
  "test_event_latest",
  {
    acUid: text("ac_uid").notNull(),
    testIdentifier: text("test_identifier").notNull().default(""),
    latestStatus: text("latest_status").notNull(),
    latestRunAt: timestamp("latest_run_at", { withTimezone: true }).notNull(),
    runCount: integer("run_count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.acUid, table.testIdentifier] }),
    check(
      "test_event_latest_status_valid",
      sql`${table.latestStatus} IN ('pass', 'fail', 'error')`,
    ),
  ]
);

// ══════════════════════════════════════
// Conversations
// ══════════════════════════════════════

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("conversations_doc_user_unique").on(table.docId, table.userId),
  ]
);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: jsonb("content").notNull(),
  seq: integer("seq").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ══════════════════════════════════════
// Relations
// ══════════════════════════════════════

export const documentsRelations = relations(documents, ({ many }) => ({
  sections: many(docSections),
  decisions: many(decisions),
  tasks: many(tasks),
  conversations: many(conversations),
}));

export const docSectionsRelations = relations(docSections, ({ one, many }) => ({
  document: one(documents, {
    fields: [docSections.docId],
    references: [documents.id],
  }),
  comments: many(docComments),
}));

export const docCommentsRelations = relations(docComments, ({ one }) => ({
  section: one(docSections, {
    fields: [docComments.sectionId],
    references: [docSections.id],
  }),
  decision: one(decisions, {
    fields: [docComments.decisionId],
    references: [decisions.id],
  }),
  task: one(tasks, {
    fields: [docComments.taskId],
    references: [tasks.id],
  }),
  // doc-26 t-4: cross_reference target relations. Named with the
  // `reference*` prefix so they don't collide with the host-target
  // section/decision/task relations above.
  referenceBrief: one(documents, {
    fields: [docComments.referenceBriefId],
    references: [documents.id],
    relationName: "doc_comments_reference_brief",
  }),
  referenceStandard: one(documents, {
    fields: [docComments.referenceStandardId],
    references: [documents.id],
    relationName: "doc_comments_reference_standard",
  }),
  referenceDecision: one(decisions, {
    fields: [docComments.referenceDecisionId],
    references: [decisions.id],
    relationName: "doc_comments_reference_decision",
  }),
  referenceTask: one(tasks, {
    fields: [docComments.referenceTaskId],
    references: [tasks.id],
    relationName: "doc_comments_reference_task",
  }),
}));

export const decisionsRelations = relations(decisions, ({ one, many }) => ({
  document: one(documents, {
    fields: [decisions.docId],
    references: [documents.id],
  }),
  blockedTasks: many(decisionDeps),
  comments: many(docComments),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  document: one(documents, {
    fields: [tasks.docId],
    references: [documents.id],
  }),
  decisionDeps: many(decisionDeps),
  dependsOn: many(taskDeps, { relationName: "dependsOn" }),
  dependedOnBy: many(taskDeps, { relationName: "dependedOnBy" }),
  comments: many(docComments),
}));

export const decisionDepsRelations = relations(decisionDeps, ({ one }) => ({
  task: one(tasks, {
    fields: [decisionDeps.taskId],
    references: [tasks.id],
  }),
  decision: one(decisions, {
    fields: [decisionDeps.decisionId],
    references: [decisions.id],
  }),
}));

export const taskDepsRelations = relations(taskDeps, ({ one }) => ({
  task: one(tasks, {
    fields: [taskDeps.taskId],
    references: [tasks.id],
    relationName: "dependsOn",
  }),
  dependsOn: one(tasks, {
    fields: [taskDeps.dependsOnId],
    references: [tasks.id],
    relationName: "dependedOnBy",
  }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  document: one(documents, {
    fields: [conversations.docId],
    references: [documents.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

// ══════════════════════════════════════
// Multi-Tenancy: Namespaces, Orgs, Memexes, Users, Org Memberships
// ══════════════════════════════════════
//
// Per std-1 / dec-1 of doc-15, three peer concepts:
//   - namespace  — URL-addressable slug. Users + orgs each own one.
//   - org        — billing/membership container. Holds memexes + members.
//   - memex      — the workspace. Contains Briefs, Standards, decisions, tasks.
//
// std-2: routing is path-based on the apex (`memex.ai/<namespace>/<memex>`); there is
// no subdomain tenant routing. std-3 governs slug allocation. std-4: org membership
// grants access to every memex in the org (no per-memex grants in v1).

export const namespaces = pgTable(
  "namespaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    kind: text("kind").notNull(),
    // Owner pointers: exactly one is set (XOR enforced by DB CHECK). `kind` discriminates.
    // Forward-references via inline anonymous functions below to break the cycle with
    // users/orgs (which are defined later in this file).
    ownerUserId: uuid("owner_user_id"),
    ownerOrgId: uuid("owner_org_id"),
    // Last time this namespace's slug changed. Powers the 30-day rename cooldown
    // (std-3 / dec-7 of doc-15). Null = never renamed.
    slugChangedAt: timestamp("slug_changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("namespaces_slug_unique").on(table.slug),
    check("namespaces_kind_valid", sql`${table.kind} IN ('user', 'org')`),
    // std-3: alphanumeric start, ≤ 39 chars, lowercase letters / digits / hyphens.
    check(
      "namespaces_slug_format",
      sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{0,38}$'`
    ),
    // Invariant "exactly one of ownerUserId / ownerOrgId is set" is enforced
    // by the application's createOrgWithOwner / ensureUserNamespace transactions
    // (services/orgs.ts, services/user-namespaces.ts). The 0042 migration
    // dropped the row-level CHECK because it couldn't be deferred across the
    // cyclic insert order namespace → org → update-namespace.
    index("namespaces_owner_user_id_idx").on(table.ownerUserId),
    index("namespaces_owner_org_id_idx").on(table.ownerOrgId),
  ]
);

export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespaceId: uuid("namespace_id").notNull().references(() => namespaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    emailDomains: jsonb("email_domains").notNull().default([]),
    autoGroupingEnabled: boolean("auto_grouping_enabled").notNull().default(false),
    domainVerified: boolean("domain_verified").notNull().default(false),
    // Per dec-10 of doc-15, referralShareTokenId is intentionally NOT carried forward.
    // Who created the org. Used for the 5-orgs-per-user-per-24h rate limit (std-3 /
    // dec-8). Nullable + ON DELETE SET NULL because user deletions don't unwind orgs.
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("orgs_namespace_id_unique").on(table.namespaceId),
    index("orgs_created_by_user_id_idx").on(table.createdByUserId),
  ]
);

// Records the user's response to a domain-match consent prompt (std-6 / dec-6).
// One row per (user, org) once any decision is made — making the prompt sticky
// per std-6's "presented exactly once per (user, org) pair" rule. `response =
// 'accepted'` rows pair with an `org_memberships` row; `'declined'` / `'skipped'`
// rows have no membership.
export const orgConsentResponses = pgTable(
  "org_consent_responses",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    response: text("response").notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.orgId] }),
    check(
      "org_consent_responses_response_valid",
      sql`${table.response} IN ('accepted', 'declined', 'skipped')`
    ),
    index("org_consent_responses_user_id_idx").on(table.userId),
  ]
);

// Slug post-rename reservation. When a namespace renames its slug, the previous
// slug lives here for 30 days (std-3 / dec-7 of doc-15) so squatters can't grab
// it and impersonate. Lookups for slug availability must check both
// `namespaces.slug` (active) and this table (held).
export const namespaceSlugReservations = pgTable(
  "namespace_slug_reservations",
  {
    slug: text("slug").primaryKey(),
    releasedNamespaceId: uuid("released_namespace_id").references(() => namespaces.id, { onDelete: "set null" }),
    reservedUntil: timestamp("reserved_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "namespace_slug_reservations_slug_format",
      sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{0,38}$'`
    ),
    index("namespace_slug_reservations_reserved_until_idx").on(table.reservedUntil),
  ]
);

export const memexes = pgTable(
  "memexes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespaceId: uuid("namespace_id").notNull().references(() => namespaces.id, { onDelete: "cascade" }),
    // Slug is unique per namespace, not globally — same slug can live in different
    // namespaces (e.g. <user>/notes and <org>/notes).
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    // Read access scope (spec-111). 'private' = org-members-only (std-4 model,
    // unchanged); 'public' = read-only for everyone incl. anonymous, write still
    // org-members-only. Defaults to 'private' so existing memexes are never
    // silently exposed by the migration.
    visibility: text("visibility").notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("memexes_namespace_id_slug_unique").on(table.namespaceId, table.slug),
    check("memexes_slug_format", sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{0,38}$'`),
    check("memexes_visibility_valid", sql`${table.visibility} IN ('public', 'private')`),
    index("memexes_namespace_id_idx").on(table.namespaceId),
  ]
);

// Visited-public-memex "pin" relationship (spec-111). Org members already see
// every org memex via `org_memberships`; this table is the SEPARATE, strictly
// non-org channel that lets a signed-in NON-member return to a public memex
// they've visited. On first visit we INSERT ... ON CONFLICT DO NOTHING. The
// memex-list query joins this alongside `org_memberships` to surface a
// read-only "Visited" group. access_level is fixed to 'read' today (no write
// path through this relationship — write still requires org membership).
export const userMemexAccess = pgTable(
  "user_memex_access",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    memexId: uuid("memex_id").notNull().references(() => memexes.id, { onDelete: "cascade" }),
    accessLevel: text("access_level").notNull().default("read"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.memexId] }),
    check("user_memex_access_level_valid", sql`${table.accessLevel} IN ('read')`),
    index("user_memex_access_memex_id_idx").on(table.memexId),
  ]
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  // Nullable: Google-SSO-only users have no password; email/password users do.
  passwordHash: text("password_hash"),
  // Nullable until proven. Set by: (a) successful verify-email token consumption,
  // (b) Google SSO with email_verified=true, (c) magic-link consumption.
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  // Disabled users retain records for content attribution but cannot access memexes.
  status: text("status").notNull().default("active"),
  // The user's own URL identity. Populated lazily by `ensureUserNamespace`
  // (services/user-namespaces.ts) on first session, OR by the 0038 migration
  // for legacy rows. Nullable to break the chicken-and-egg with
  // `namespaces.owner_user_id` at signup time. UNIQUE so one user → one namespace.
  namespaceId: uuid("namespace_id").references(() => namespaces.id, { onDelete: "set null" }),
  // spec-206 (dec-3): the server-authoritative first-run flag for the Specky
  // welcome. Null = the user has never been greeted; a timestamp = the first
  // session where Specky's opening turn actually started speaking (dec-4 — a
  // blocked/denied audio start does NOT stamp it). True once-per-user across
  // devices, so the auto-greeting never re-fires.
  onboardingGreetedAt: timestamp("onboarding_greeted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("users_status_valid", sql`${table.status} IN ('active', 'disabled')`),
  unique("users_namespace_id_unique").on(table.namespaceId),
]);

// Single-use tokens for email verification, magic-link login, and password reset.
// Stored as a sha256 hash — the raw token is emailed and never persisted. `email` holds
// the destination address so magic-link signups (user doesn't exist yet) still work.
export const authTokens = pgTable("auth_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  purpose: text("purpose").notNull(),
  // Nullable for pre-user tokens (magic-link signup case). Once consumed, the caller
  // uses `email` to upsert/find the user.
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check(
    "auth_tokens_purpose_valid",
    sql`${table.purpose} IN ('email_verification', 'magic_link', 'password_reset')`
  ),
]);

export const orgMemberships = pgTable(
  "org_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    // Role is per-org: a user can be admin of one org and member of another.
    role: text("role").notNull(),
    // Per-org disable: 'disabled' rows are retained (so prior contributions stay
    // attributed) but never grant access. std-6: never silently re-activated through any
    // code path. Distinct from users.status (a global lockout).
    status: text("status").notNull().default("active"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("org_memberships_user_id_org_id_unique").on(table.userId, table.orgId),
    check("org_memberships_role_valid", sql`${table.role} IN ('member', 'administrator')`),
    check("org_memberships_status_valid", sql`${table.status} IN ('active', 'disabled')`),
    index("org_memberships_user_id_idx").on(table.userId),
    index("org_memberships_org_id_idx").on(table.orgId),
  ]
);

// ══════════════════════════════════════
// Per-Spec roles + assignment (spec-118)
// ══════════════════════════════════════
//
// Two per-Spec relations layered ABOVE the org-level access gate (std-4 is
// unchanged): role decides capability + UI posture, assignment decides
// responsibility. Neither narrows read access — a reviewer reads every field an
// editor does. Generic `doc_*` naming matches the documents/doc convention.
//
// doc_members — the canonical per-Spec membership table (spec-118 dec-1). v1 writes
// only 'editor' rows; a member with NO row resolves to the implicit 'reviewer'
// default (dec-6), so reading a Spec never writes a row. UNIQUE(doc_id,user_id)
// makes promote an idempotent upsert and demote a delete (dec-5). The role CHECK is
// exactly {editor,reviewer} (ac-7 / ac-8). doc_id → documents ON DELETE CASCADE so
// deleting a Spec drops its membership; user_id → users CASCADE so deleting a user
// drops their rows.
export const docMembers = pgTable(
  "doc_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("doc_members_doc_id_user_id_unique").on(table.docId, table.userId),
    index("doc_members_doc_id_idx").on(table.docId),
    index("doc_members_user_id_idx").on(table.userId),
    check("doc_members_role_valid", sql`${table.role} IN ('editor', 'reviewer')`),
  ]
);

// doc_assignees — ticket-style assignment, INDEPENDENT of role (spec-118 dec-3).
// Assigning a user writes NO doc_members row; "owner" is subsumed by "assignee".
// One-or-more assignees per Spec; UNIQUE(doc_id,user_id) makes assign idempotent and
// unassign a delete. `assigned_by` records attribution (ON DELETE SET NULL so
// removing the actor keeps the assignment). assign/unassign flow through mutate()
// with entity:"doc_assignee" and emit on the unified bus (std-8, ac-20). The
// user_id index backs the "assigned to me" board filter (ac-19).
export const docAssignees = pgTable(
  "doc_assignees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("doc_assignees_doc_id_user_id_unique").on(table.docId, table.userId),
    index("doc_assignees_doc_id_idx").on(table.docId),
    index("doc_assignees_user_id_idx").on(table.userId),
  ]
);

// ══════════════════════════════════════
// Tags (spec-136)
// ══════════════════════════════════════

// The per-Memex catalogue of distinct tags. One row per unique {scope, value}
// (dec-1: a structured tag, not a parsed string). A flat/unscoped tag is stored
// with scope = NULL. Reused across Specs via the type-ahead create-or-pick.
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    // The part before `::` (`priority` in `priority::high`). NULL = a flat,
    // multi-valued tag (`bug`, `frontend`).
    scope: text("scope"),
    // The part after `::`, or the whole tag for a flat one. Never NULL.
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Canonicalises a tag to one row per Memex (dec-1). nullsNotDistinct is
    // essential: without it two flat `bug` tags (scope = NULL) would both be
    // allowed (NULL <> NULL in a default unique), defeating canonicalisation.
    unique("tags_memex_scope_value_unique")
      .on(table.memexId, table.scope, table.value)
      .nullsNotDistinct(),
    index("tags_memex_id_idx").on(table.memexId),
  ]
);

// The bridge linking a tag to a Spec (dec-2: one FK-backed bridge to `documents`,
// not a polymorphic object_tags table). The FK with ON DELETE CASCADE is the point:
// deleting a Spec removes its tag links automatically — no orphans, no sweep.
// Attribution mirrors doc_assignees.assigned_by: a single `added_by` FK to users
// (ON DELETE SET NULL). Actor *kind* (human/mcp_agent/system) is carried on the
// bus ChangeEvent → activity_log (spec-122), not denormalised onto this row.
export const documentTags = pgTable(
  "document_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    docId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A Spec cannot carry the same tag twice; a repeat assignment is idempotent.
    unique("document_tags_document_tag_unique").on(table.docId, table.tagId),
    // Forward filter ("tags on this Spec") and reverse lookup ("Specs with this
    // tag"), both tenant-scoped so the query never joins just to scope by tenant.
    index("document_tags_memex_document_idx").on(table.memexId, table.docId),
    index("document_tags_memex_tag_idx").on(table.memexId, table.tagId),
  ]
);

export const inviteTokens = pgTable("invite_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  // Multi-use: link stays valid until explicitly revoked or expires_at is reached.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-Org scaffold guidance additions (b-68 dec-2 / dec-3).
//
// Persists `source: 'org'` GuidanceBlock rows for the unified Scaffold model
// (`@memex/shared/scaffold-model`). There is deliberately no `source` column —
// the table IS the discriminator: every row produced by this table is rendered
// with `source: 'org'` at the service-read mapping layer. This is how dec-3's
// "append-only at the data layer" guarantee holds: there is literally no
// schema path to write `source: 'base'` because the column doesn't exist.
// Base guidance lives in code (`scaffold-data.ts` in @memex/shared), not in
// this table, so the Org mutation surface cannot reach it.
//
// `target_*` columns roll up into the `target: { phase?, tool?, transition? }`
// shape on read. An absent dimension matches every value of that dimension
// (b-68 dec-1). All three NULL is allowed — that's an org-global block.
//
// `display_order` is the on-disk column name; `order` is a SQL reserved word.
// The service-layer GuidanceBlock view maps `display_order` → `order`.
export const orgScaffoldAdditions = pgTable(
  "org_scaffold_additions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    // spec-193 t-5 (dec-6 grain): optional per-memex scope. NULL = account-wide
    // — applies to every memex in the Org's namespace (existing behaviour, the
    // default for security / house-style blocks). Set = applies ONLY to that
    // memex (the override). Resolution merges account-wide + per-memex at query
    // time. ON DELETE CASCADE so deleting a memex drops its scoped overrides;
    // account-wide rows (NULL) are untouched.
    memexId: uuid("memex_id").references(() => memexes.id, { onDelete: "cascade" }),
    // Phase the block attaches to. NULL = matches every phase.
    targetPhase: text("target_phase"),
    // Tool name the block attaches to. NULL = matches every tool.
    targetTool: text("target_tool"),
    // Forward transition the block attaches to (rubric channel). NULL = not a
    // transition block. Mutually-exclusive-in-practice with phase/tool but the
    // schema does not enforce this — the projection functions in
    // `@memex/shared` decide which channel a row rides.
    targetTransition: text("target_transition"),
    // Prompt Button id the block attaches to (spec-103 D-7). Free-form slug
    // (e.g. 'verify-spec'), NOT an enum — so no CHECK constraint. NULL = not a
    // button-targeted block.
    targetButton: text("target_button"),
    text: text("text").notNull(),
    rationale: text("rationale").notNull(),
    emphasis: text("emphasis"),
    enabled: boolean("enabled").notNull().default(true),
    // `order` is a SQL reserved word; column name is `display_order` on disk.
    // The service layer maps this back to GuidanceBlock.order at read time.
    displayOrder: integer("display_order").notNull().default(0),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // spec-181 (dec-2): the second pipeline phase renamed `plan`→`specify`;
    // migration 0078 flips these target columns and swaps 'specify' for 'plan'
    // in both CHECKs.
    check(
      "org_scaffold_additions_target_phase_valid",
      sql`${table.targetPhase} IS NULL OR ${table.targetPhase} IN ('draft', 'specify', 'build', 'verify', 'done')`
    ),
    check(
      "org_scaffold_additions_target_transition_valid",
      sql`${table.targetTransition} IS NULL OR ${table.targetTransition} IN ('specify', 'build', 'verify', 'done')`
    ),
    check(
      "org_scaffold_additions_emphasis_valid",
      sql`${table.emphasis} IS NULL OR ${table.emphasis} IN ('do', 'dont')`
    ),
    index("org_scaffold_additions_org_id_idx").on(table.orgId),
    // spec-193 t-5: the per-memex merge reads `WHERE org_id = ? AND (memex_id
    // IS NULL OR memex_id = ?)`; index (org_id, memex_id) so account-wide +
    // per-memex resolution stays an index scan.
    index("org_scaffold_additions_org_id_memex_id_idx").on(table.orgId, table.memexId),
    index("org_scaffold_additions_org_id_target_idx").on(
      table.orgId,
      table.targetPhase,
      table.targetTool,
      table.targetTransition,
      table.targetButton,
    ),
  ]
);

export const shareTokens = pgTable("share_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Long-lived MCP API tokens issued per (user × device). Token value `mxt_<random>` is
// stored as a SHA256 hash; `prefix` keeps the first 8 chars for "mxt_xxxxxxxx…" display
// in the settings UI. `label` is auto-derived from the installer's hostname. Revoking
// sets `revokedAt` (we never delete) so audit trails stay intact.
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mcp_tokens_user_id_idx").on(table.userId)]
);

// Long-lived per-Memex emission keys gating POST /api/test-events (spec-129). Modelled
// directly on mcp_tokens: the raw key `mxk_<random>` is stored only as a SHA-256 hash
// (`hashed_key`, unique-indexed for O(1) auth lookup, dec-5); `prefix` keeps the leading
// chars for an `mxk_xxxxxxxx…` display in settings (never the raw key, never the hash).
// Revoking sets `revoked_at` — rows are NEVER hard-deleted (dec-4), so the key list and
// audit trail stay intact. Multiple non-revoked keys per Memex live simultaneously: that
// IS the rotation mechanism (mint new → roll out → revoke old, no time pressure, dec-4).
//
// There is deliberately NO anonymous-emission path (dec-3 / dec-7): a valid key is
// required for every emission, so no `allow_anonymous_emission` flag exists anywhere.
//
// `created_by_user_id` (spec-129 dec-8) records the member who minted the key. It powers
// the member-level access matrix: a member sees + revokes only their OWN keys, while an
// admin sees + revokes every key on the Memex. ON DELETE SET NULL keeps the key (and its
// audit trail) alive if the creator's account is deleted — the key keeps working and stays
// admin-revocable; only its member-ownership claim is dropped. Nullable: keys minted before
// this column existed (and any future admin-side mint with no acting member) have no owner.
export const memexEmissionKeys = pgTable(
  "memex_emission_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id")
      .notNull()
      .references(() => memexes.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hashedKey: text("hashed_key").notNull().unique(),
    prefix: text("prefix").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memex_emission_keys_memex_id_idx").on(table.memexId),
    index("memex_emission_keys_created_by_user_id_idx").on(table.createdByUserId),
  ]
);

// Per-user Slack OAuth credentials (doc-23 / b-56). Token is encrypted at rest via GCP KMS
// envelope encryption (per D-2 of doc-23): `ciphertext` is AES-256-GCM(token) with a
// per-row DEK + 12-byte IV; `wrapped_dek` is the DEK encrypted by the master
// CryptoKey in KMS. Local-dev plaintext mode writes raw token to `ciphertext` with
// `wrapped_dek` and `iv` both zero-length — gated behind NODE_ENV !== 'production' in
// services/.ee/slack/crypto.ts.
// Unique key is (user_id, org_id) NULLS NOT DISTINCT (b-56 D-3): one Slack workspace
// per user per org; org_id = NULL is the legacy global fallback for rows created before
// the per-org scoping migration. Mutations emit via mutate() with memexId="" + userId set,
// mirroring mcp_tokens for /api/me/events SSE fanout (per std-8 §3).
export const userSlackTokens = pgTable(
  "user_slack_tokens",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id").notNull(),
    slackWorkspaceId: text("slack_workspace_id").notNull(),
    slackBotUserId: text("slack_bot_user_id"),
    scope: text("scope").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    wrappedDek: bytea("wrapped_dek").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("user_slack_tokens_workspace_idx").on(table.slackWorkspaceId),
  ]
);

// Display-name → Slack user-ID cache (doc-23 §6, T-7). Avoids hammering Slack's
// users.list endpoint for repeat lookups. Per-(workspace, display_name) primary key
// — display_name stored lowercased+trimmed (normalised at write time by the resolver).
// Entries older than 7 days are bypassed and refreshed (TTL enforced at query time,
// not by a cleanup job — stale rows are harmless).
//
// Workspace-scoped, not memex-scoped. Silent-allowed per std-8 §6 (cache writes
// produce no user-observable change) — writes flow through mutate({silent:true}).
export const slackUserCache = pgTable(
  "slack_user_cache",
  {
    slackWorkspaceId: text("slack_workspace_id").notNull(),
    displayName: text("display_name").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.slackWorkspaceId, table.displayName] }),
    index("slack_user_cache_updated_at_idx").on(table.updatedAt),
  ]
);

// ─── OAuth 2.1 + Dynamic Client Registration + PKCE (b-31 W1) ──────────────
//
// Three additive tables that power the Anthropic Connectors Directory listing.
// Coexist with `mcp_tokens` per dec-1 — the /mcp route forks on token prefix
// (`mxt_…` → mcpTokens path; JWT → OAuth path). Migrations here NEVER touch
// existing tables — adding new ones only.
//
// Token storage uses the same shape as mcp_tokens: SHA-256 hashes, never
// plaintext, soft-delete via `revoked_at`.

// Dynamic-Client-Registration entry (RFC 7591). Anonymous registration per
// dec-7(a): any caller can POST /oauth/register and receive a client_id. The
// returned `client_secret` is one-shot — its SHA-256 hash is stored here.
// Public-client (PKCE-only) clients pass null for the secret.
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Public identifier the client sends on every request. Distinct from the
    // row id so we can rotate it without re-keying foreign keys.
    clientId: text("client_id").notNull().unique(),
    // Nullable for public clients (Claude Desktop, Claude Code via mcp-remote
    // — PKCE-only, no secret).
    clientSecretHash: text("client_secret_hash"),
    clientName: text("client_name").notNull(),
    redirectUris: text("redirect_uris").array().notNull(),
    // RFC 7592 — lets a client manage its own registration. Hashed.
    registrationAccessTokenHash: text("registration_access_token_hash").notNull(),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    // Single 'memex.full' scope in v1 per dec-2. Stored as text[] for
    // forward-compat with future granular scopes.
    scopes: text("scopes").array().notNull().default(sql`ARRAY['memex.full']::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("oauth_clients_client_id_idx").on(table.clientId)],
);

// Authorization codes — ephemeral PKCE-bound codes returned from /authorize and
// exchanged at /token for an access+refresh pair. Single-use, expire in 10
// minutes per dec-7(b). Stored as SHA-256 hash to match the mcp_tokens
// pattern; the plaintext code only ever exists in the redirect URL.
export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull().unique(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Chosen Org for this grant (per dec-8). Nullable when the user has no
    // Org memberships — they authorise against their personal Memex only.
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    // Must match what the client sent to /authorize when exchanging at /token.
    redirectUri: text("redirect_uri").notNull(),
    // PKCE (RFC 7636) — challenge sent at /authorize, verifier sent at /token.
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set when /token exchanges this code. Single-use: re-use → 400.
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("oauth_auth_codes_expires_at_idx").on(table.expiresAt),
    check(
      "oauth_auth_codes_method_valid",
      sql`${table.codeChallengeMethod} = 'S256'`,
    ),
  ],
);

// Rotating refresh tokens (30-day TTL per D-3). Each token is single-use:
// /token with grant_type=refresh_token consumes the old one and mints a fresh
// one with the SAME `chain_id`. Reuse of a consumed token signals theft → per
// dec-7(c) revoke every token in that chain (cascading across rotations), but
// NOT the user's other OAuth chains.
//
// Access tokens (JWTs, 1h TTL per D-3) are stateless and live in
// services/auth-jwt.ts — they are NOT stored here. This table holds refresh
// tokens only.
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    // Lineage marker — same uuid across every rotation in this chain. Reuse
    // detection revokes every row sharing this chain_id.
    chainId: uuid("chain_id").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Org-scope for this chain (per dec-8). Same value across every rotation
    // in the chain. Nullable when the grant covers personal-only.
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set when this token is exchanged for a new one. Single-use.
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // Set when reuse is detected (or the user revokes from /settings/tokens).
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("oauth_refresh_tokens_chain_id_idx").on(table.chainId),
    index("oauth_refresh_tokens_user_id_idx").on(table.userId),
    index("oauth_refresh_tokens_user_org_idx").on(table.userId, table.orgId),
    index("oauth_refresh_tokens_expires_at_idx").on(table.expiresAt),
  ],
);

// Ephemeral state for the CLI installer device-flow. The installer POSTs /cli/auth/start
// to claim a `code` (e.g., ABCD-1234), opens the user's browser to the React UI's
// confirm page (which calls /cli/auth/complete), then long-polls /cli/auth/poll/:reqId
// for the minted token. Rows expire 5 minutes after creation.
export const cliAuthRequests = pgTable(
  "cli_auth_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    status: text("status").notNull().default("pending"),
    // Set after /cli/auth/complete — the minted token's plaintext is held here only
    // until the installer's poll picks it up, then cleared. (Token is also hashed into
    // mcp_tokens; this column is just for the one-time handoff.)
    mintedToken: text("minted_token"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "cli_auth_requests_status_valid",
      sql`${table.status} IN ('pending', 'completed', 'consumed')`
    ),
  ]
);

export const verifiedDomains = pgTable("verified_domains", {
  // Domain is the natural primary key — only one org can claim a given domain.
  domain: text("domain").primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  verificationMethod: text("verification_method").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check(
    "verified_domains_method_valid",
    sql`${table.verificationMethod} IN ('sso', 'email')`
  ),
]);

// Pending email-verification tokens. A token is created when an admin initiates
// verification for a domain; deleted/marked-used after the recipient (admin@/postmaster@)
// clicks through. Distinct from invite_tokens: a single email-domain claim, not a
// multi-use seat invitation.
export const domainVerificationTokens = pgTable("domain_verification_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  // The email-domain being verified (e.g., "acme.com"). Stored alongside the org to
  // catch the case where an org's email_domains list changes between create and consume.
  domain: text("domain").notNull(),
  token: text("token").notNull().unique(),
  used: boolean("used").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-org Discord webhook URL for memex__send_discord_message (spec-138 dec-1).
// One webhook per org — org_id is the primary key (UNIQUE by design). Webhook URLs are
// treated as non-secret configuration (Discord recommends rotating if leaked) so no
// envelope encryption is applied, unlike user_slack_tokens. channel_name is a display
// label only — routing always uses the webhook URL's embedded channel target.
// Hard-delete on disconnect (no soft-delete): webhook URLs have no audit-trail requirement.
export const orgDiscordWebhooks = pgTable("org_discord_webhooks", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  webhookUrl: text("webhook_url").notNull(),
  channelName: text("channel_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const namespacesRelations = relations(namespaces, ({ one, many }) => ({
  ownerUser: one(users, {
    fields: [namespaces.ownerUserId],
    references: [users.id],
    relationName: "ownerUser",
  }),
  ownerOrg: one(orgs, {
    fields: [namespaces.ownerOrgId],
    references: [orgs.id],
    relationName: "ownerOrg",
  }),
  memexes: many(memexes),
}));

export const orgsRelations = relations(orgs, ({ one, many }) => ({
  namespace: one(namespaces, {
    fields: [orgs.namespaceId],
    references: [namespaces.id],
  }),
  memberships: many(orgMemberships),
  inviteTokens: many(inviteTokens),
  verifiedDomains: many(verifiedDomains),
}));

export const memexesRelations = relations(memexes, ({ one }) => ({
  namespace: one(namespaces, {
    fields: [memexes.namespaceId],
    references: [namespaces.id],
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  namespace: one(namespaces, {
    fields: [users.namespaceId],
    references: [namespaces.id],
  }),
  memberships: many(orgMemberships),
}));

export const orgMembershipsRelations = relations(orgMemberships, ({ one }) => ({
  user: one(users, {
    fields: [orgMemberships.userId],
    references: [users.id],
  }),
  org: one(orgs, {
    fields: [orgMemberships.orgId],
    references: [orgs.id],
  }),
}));

export const inviteTokensRelations = relations(inviteTokens, ({ one }) => ({
  org: one(orgs, {
    fields: [inviteTokens.orgId],
    references: [orgs.id],
  }),
}));

export const shareTokensRelations = relations(shareTokens, ({ one }) => ({
  document: one(documents, {
    fields: [shareTokens.documentId],
    references: [documents.id],
  }),
}));

export const verifiedDomainsRelations = relations(verifiedDomains, ({ one }) => ({
  org: one(orgs, {
    fields: [verifiedDomains.orgId],
    references: [orgs.id],
  }),
}));

// ══════════════════════════════════════
// Redirects (b-36 T-4)
// ══════════════════════════════════════
// Stores `old_path → new_path` rewrites for canonical refs after a Spec
// moves between memexes, or a namespace/memex slug renames. ONE row per
// move event — the resolver in `services/redirects.ts` prefix-matches on
// read so child paths (.../tasks/t-1, .../sections/s-2) inherit without
// per-entity rows. Direct entity lookup runs first (T-5); this layer is
// the fallback. Transitive A→B + B→C chains are followed in-app with a
// cycle guard. No automatic expiry.

export const redirects = pgTable(
  "redirects",
  {
    oldPath: text("old_path").primaryKey(),
    newPath: text("new_path").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "redirects_reason_valid",
      sql`${table.reason} IN ('brief_move', 'memex_rename', 'namespace_rename')`
    ),
    index("redirects_new_path_idx").on(table.newPath),
  ]
);

// ══════════════════════════════════════
// Waitlist (public signups from www.memex.ai marketing site)
// ══════════════════════════════════════

export const waitlistEntries = pgTable("waitlist_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  company: text("company").notNull(),
  email: text("email").notNull().unique(),
  deployment: text("deployment").notNull().default("any"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ══════════════════════════════════════
// Codebase Intelligence
// ══════════════════════════════════════
// Deterministic distillation of a customer repo into structured Postgres
// tables. Written by the @memex/extractor worker, read by agent-facing
// MCP tools and by the React UI. See feat-memex-repo-ingestion in blueprint
// for the governing design.
//
// Top-level entity is `repos`, scoped per-memex. All child tables (files,
// symbols, etc.) cascade from repos and infer memex scope via repo_id joins.

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id")
      .notNull()
      .references(() => memexes.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("repos_memex_id_url_unique").on(table.memexId, table.url),
    // Names are unique per memex too — prevents "proxy" and "proxy" with
    // different URLs from confusing natural-language repo lookup.
    unique("repos_memex_id_name_unique").on(table.memexId, table.name),
    index("repos_memex_id_idx").on(table.memexId),
  ]
);

export const repoScope = pgTable(
  "repo_scope",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    includePath: text("include_path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("repo_scope_repo_id_idx").on(table.repoId),
  ]
);

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    language: text("language"),
    content: text("content"),
    // Generated full-text-search vector. Written automatically by Postgres on
    // every insert/update. Query via `tsv @@ plainto_tsquery(...)`.
    contentTsv: tsvector("content_tsv").generatedAlwaysAs(
      sql`to_tsvector('english'::regconfig, COALESCE(content, ''::text))`,
    ),
    sizeBytes: integer("size_bytes"),
    gitHash: text("git_hash"),
    isTest: boolean("is_test").notNull().default(false),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }),
  },
  (table) => [
    unique("files_repo_id_path_unique").on(table.repoId, table.path),
    index("files_repo_id_idx").on(table.repoId),
    index("files_repo_id_language_idx").on(table.repoId, table.language),
    index("files_content_tsv_idx").using("gin", table.contentTsv),
    check(
      "files_language_valid",
      sql`${table.language} IS NULL OR ${table.language} IN ('python', 'typescript', 'javascript', 'go', 'rust', 'dart')`,
    ),
  ]
);

export const symbols = pgTable(
  "symbols",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    parentName: text("parent_name"),
    signature: text("signature"),
    lineStart: integer("line_start"),
    lineEnd: integer("line_end"),
    isExported: boolean("is_exported").notNull().default(false),
    isAsync: boolean("is_async").notNull().default(false),
    language: text("language"),
    docComment: text("doc_comment"),
  },
  (table) => [
    unique("symbols_file_name_kind_line_unique").on(
      table.fileId,
      table.name,
      table.kind,
      table.lineStart,
    ),
    index("symbols_repo_id_idx").on(table.repoId),
    index("symbols_file_id_idx").on(table.fileId),
    index("symbols_repo_id_name_idx").on(table.repoId, table.name),
    index("symbols_repo_id_kind_idx").on(table.repoId, table.kind),
    check(
      "symbols_kind_valid",
      sql`${table.kind} IN ('function', 'class', 'method', 'interface', 'type', 'enum', 'constant', 'field')`,
    ),
    check(
      "symbols_language_valid",
      sql`${table.language} IS NULL OR ${table.language} IN ('python', 'typescript', 'javascript', 'go', 'rust', 'dart')`,
    ),
  ]
);

export const dependencies = pgTable(
  "dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fromFileId: uuid("from_file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    // Null when the import can't be resolved to an internal file (external
    // packages), in which case `toPackage` is set instead.
    toFileId: uuid("to_file_id").references(() => files.id, { onDelete: "set null" }),
    toPackage: text("to_package"),
    importedSymbols: text("imported_symbols").array(),
    kind: text("kind").notNull(),
  },
  (table) => [
    index("dependencies_repo_id_idx").on(table.repoId),
    index("dependencies_from_file_id_idx").on(table.fromFileId),
    index("dependencies_to_file_id_idx").on(table.toFileId),
    check("dependencies_kind_valid", sql`${table.kind} IN ('internal', 'external')`),
  ]
);

export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fromSymbolId: uuid("from_symbol_id")
      .notNull()
      .references(() => symbols.id, { onDelete: "cascade" }),
    toName: text("to_name").notNull(),
    // Null when the callee can't be resolved (builtins, stdlib, dynamic
    // dispatch). `isNoise` annotates why: true for known builtins/stdlib.
    toSymbolId: uuid("to_symbol_id").references(() => symbols.id, { onDelete: "set null" }),
    lineNumber: integer("line_number"),
    // How `toSymbolId` was resolved: 'local', 'cross_module', or 'inheritance'
    // (self-method via MRO walk). Null when toSymbolId is null.
    resolutionKind: text("resolution_kind"),
    isNoise: boolean("is_noise").notNull().default(false),
  },
  (table) => [
    index("calls_from_symbol_id_idx").on(table.fromSymbolId),
    index("calls_to_symbol_id_idx").on(table.toSymbolId),
    index("calls_repo_id_idx").on(table.repoId),
    check(
      "calls_resolution_kind_valid",
      sql`${table.resolutionKind} IS NULL OR ${table.resolutionKind} IN ('local', 'cross_module', 'inheritance', 'external')`,
    ),
  ]
);

export const embeddings = pgTable(
  "embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "cascade" }),
    symbolId: uuid("symbol_id").references(() => symbols.id, { onDelete: "cascade" }),
    chunkText: text("chunk_text").notNull(),
    chunkKind: text("chunk_kind"),
    embedding: vector1536("embedding"),
    // Provider + variant tag, e.g. 'openai-text-embedding-3-large-1536'.
    // Enables A/B of embedding models without a data migration: agent can
    // filter `WHERE model = '<tag>'` at query time.
    model: text("model").notNull().default("openai-text-embedding-3-large-1536"),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }),
  },
  (table) => [
    index("embeddings_repo_id_idx").on(table.repoId),
    index("embeddings_file_id_idx").on(table.fileId),
    index("embeddings_repo_model_idx").on(table.repoId, table.model),
  ]
);

// spec-190 t-6 (dec-6): the voice guide's knowledge store — a GLOBAL corpus of
// product documentation (how Memex works), NOT tenant-scoped (no memex_id). The
// guide teaches the product's shape, identical for every Memex, and never reads
// tenant content (dec-4). Rows are heading-bounded markdown chunks imported from
// guide-content/ by t-7's db:import-guide-content (screens/<key>.md carry a
// screen_key; concepts/*.md leave it NULL).
//
// Retrieval (services/guide-content.ts) is two-layer: Layer 1 (ac-14) is a
// deterministic screen_key lookup on route change — no embedding, no vector
// search; Layer 2 (ac-15) is a per-turn pgvector cosine search over the whole
// corpus, with content_tsv (GIN) as the FTS fallback. Embeddings are written
// via the EmbeddingProvider abstraction (ac-13); embedding_model tags the
// provider so query-time vectors filter to the same population.
export const guideContent = pgTable(
  "guide_content",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // NULL for cross-screen concept chunks; set for per-screen chunks.
    screenKey: text("screen_key"),
    sourcePath: text("source_path").notNull(),
    chunkIndex: integer("chunk_index").notNull().default(0),
    heading: text("heading"),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    embedding: vector1536("embedding"),
    embeddingModel: text("embedding_model"),
    // Generated full-text-search vector, written automatically by Postgres.
    contentTsv: tsvector("content_tsv").generatedAlwaysAs(
      sql`to_tsvector('english'::regconfig, COALESCE(content, ''::text))`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Importer upsert key — one row per (file, chunk).
    uniqueIndex("guide_content_source_path_chunk_idx").on(table.sourcePath, table.chunkIndex),
    // Layer-1 deterministic pre-fetch.
    index("guide_content_screen_key_idx").on(table.screenKey),
    // Layer-2 FTS fallback.
    index("guide_content_content_tsv_idx").using("gin", table.contentTsv),
    // Model-scoped filter parity (HNSW vector index lives in the migration —
    // drizzle-kit can't express `USING hnsw (... vector_cosine_ops)`).
    index("guide_content_embedding_model_idx").on(table.embeddingModel),
  ]
);

export const repoEndpoints = pgTable(
  "repo_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    handlerSymbolId: uuid("handler_symbol_id").references(() => symbols.id, { onDelete: "set null" }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    handlerName: text("handler_name"),
    lineNumber: integer("line_number"),
    framework: text("framework"),
  },
  (table) => [
    index("repo_endpoints_repo_id_idx").on(table.repoId),
    index("repo_endpoints_repo_id_path_idx").on(table.repoId, table.path),
  ]
);

export const repoStructure = pgTable(
  "repo_structure",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    pathPattern: text("path_pattern").notNull(),
    fileCount: integer("file_count"),
    confidence: doublePrecision("confidence"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("repo_structure_repo_id_idx").on(table.repoId),
  ]
);

export const repoPatterns = pgTable(
  "repo_patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(),
    evidence: text("evidence").array(),
    confidence: doublePrecision("confidence"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("repo_patterns_repo_id_idx").on(table.repoId),
  ]
);

export const repoDomains = pgTable(
  "repo_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rootPaths: text("root_paths").array(),
    fileCount: integer("file_count"),
    symbolCount: integer("symbol_count"),
    keySymbols: text("key_symbols").array(),
    // Business names the team uses for this domain: "proxy", "agent v3".
    // Looked up via `'proxy' = ANY(aliases)` during agent prompting.
    aliases: text("aliases").array(),
    description: text("description"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("repo_domains_repo_id_idx").on(table.repoId),
  ]
);

export const repoTechStack = pgTable(
  "repo_tech_stack",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    layer: text("layer").notNull(),
    name: text("name").notNull(),
    version: text("version"),
    evidence: text("evidence").array(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("repo_tech_stack_repo_id_idx").on(table.repoId),
  ]
);

export const testCoverage = pgTable(
  "test_coverage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    testSymbolId: uuid("test_symbol_id")
      .notNull()
      .references(() => symbols.id, { onDelete: "cascade" }),
    subjectSymbolId: uuid("subject_symbol_id").references(() => symbols.id, { onDelete: "cascade" }),
    subjectFileId: uuid("subject_file_id").references(() => files.id, { onDelete: "cascade" }),
    linkMethod: text("link_method").notNull(),
    confidence: doublePrecision("confidence"),
  },
  (table) => [
    index("test_coverage_repo_id_idx").on(table.repoId),
    index("test_coverage_subject_symbol_id_idx").on(table.subjectSymbolId),
    check(
      "test_coverage_link_method_valid",
      sql`${table.linkMethod} IN ('import', 'call_graph', 'path_mirror', 'name_match')`,
    ),
  ]
);

// ── Blueprint / Decision bridge ───────────────────
// In Memex a "blueprint" IS a decision (dec-N), so this bridge table connects
// repo files to the decisions that govern them. One table where the two halves
// of Memex meet (codebase intelligence + decision tracking).

export const decisionFileCoverage = pgTable(
  "decision_file_coverage",
  {
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => decisions.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    reason: text("reason"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.decisionId, table.fileId] }),
  ]
);

export const driftSignals = pgTable(
  "drift_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => decisions.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "cascade" }),
    symbolId: uuid("symbol_id").references(() => symbols.id, { onDelete: "cascade" }),
    signal: text("signal").notNull(),
    severity: text("severity"),
    resolved: boolean("resolved").notNull().default(false),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("drift_signals_decision_id_idx").on(table.decisionId),
    index("drift_signals_file_id_idx").on(table.fileId),
  ]
);

// A Memex Spec is a document with docType='spec'. Linking Specs to the
// repos they involve lets MCP tools answer "which repos are in scope for this
// Spec?" as the entry point for any codebase-intelligence query. The table
// name (`mission_repos`), the Drizzle export (`missionRepos`), and the
// `mission_id` column are kept for migration compatibility (column names
// preserved per b-105 allowlist) — the conceptual entity is now a Spec.
export const missionRepos = pgTable(
  "mission_repos",
  {
    missionId: uuid("mission_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.missionId, table.repoId] }),
  ]
);

// ══════════════════════════════════════
// Activity log (Pulse — b-60)
// ══════════════════════════════════════

// Append-only feed of what happened across a Memex, regardless of which surface
// drove the change. Every meaningful mutation writes one immutable row (no
// updatedAt). Pulse renders these as a chronological timeline.
//
// `actorKind` = WHO acted; `channel` = THROUGH WHAT surface it arrived; `clientId`
// = opaque per-client correlation id for threading one actor's activity across
// requests. `briefId` points at a document with docType='spec' (column name
// preserved per b-105 allowlist — the conceptual entity is now a Spec). briefId
// and actorUserId are nullable + ON DELETE SET NULL so deleting a Spec or user
// keeps the historical row (it just loses the live link); memexId is NOT NULL
// + CASCADE.
//
// NOTE: the three indexes use DESC ordering on createdAt, and two are partial
// (WHERE briefId / actorUserId IS NOT NULL). Drizzle's index() builder can't
// express DESC/partial here, so those nuances live in the hand-written migration
// (drizzle/0060_add_activity_log.sql). The index() entries below keep schema.ts
// honest about which columns are indexed.
export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id")
      .notNull()
      .references(() => memexes.id, { onDelete: "cascade" }),
    briefId: uuid("brief_id").references(() => documents.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorKind: text("actor_kind").notNull(),
    channel: text("channel").notNull(),
    clientId: text("client_id"),
    entity: text("entity").notNull(),
    action: text("action").notNull(),
    narrative: text("narrative").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("activity_log_memex_id_created_at_idx").on(table.memexId, table.createdAt),
    index("activity_log_brief_id_created_at_idx").on(table.briefId, table.createdAt),
    index("activity_log_actor_user_id_client_id_created_at_idx").on(
      table.actorUserId,
      table.clientId,
      table.createdAt
    ),
    check(
      "activity_log_actor_kind_valid",
      sql`${table.actorKind} IN ('human', 'mcp_agent', 'in_app_agent', 'system')`
    ),
    check(
      "activity_log_channel_valid",
      sql`${table.channel} IN ('rest_ui', 'mcp', 'in_app_agent', 'server')`
    ),
  ]
);

// ── Relations (codebase intelligence) ────────────
// Minimum set the services are likely to need. Extend as needed.

export const reposRelations = relations(repos, ({ one, many }) => ({
  memex: one(memexes, {
    fields: [repos.memexId],
    references: [memexes.id],
  }),
  scopes: many(repoScope),
  files: many(files),
}));

export const filesRelations = relations(files, ({ one, many }) => ({
  repo: one(repos, {
    fields: [files.repoId],
    references: [repos.id],
  }),
  symbols: many(symbols),
}));

export const symbolsRelations = relations(symbols, ({ one }) => ({
  repo: one(repos, {
    fields: [symbols.repoId],
    references: [repos.id],
  }),
  file: one(files, {
    fields: [symbols.fileId],
    references: [files.id],
  }),
}));

// ══════════════════════════════════════
// Types
// ══════════════════════════════════════

export type Doc = InferSelectModel<typeof documents>;
export type DocSection = InferSelectModel<typeof docSections>;
export type StandardClause = InferSelectModel<typeof standardClauses>;
export type ClauseRef = InferSelectModel<typeof clauseRefs>;
export type ClauseRefInsert = InferInsertModel<typeof clauseRefs>;
export type DocComment = InferSelectModel<typeof docComments>;
export type Decision = InferSelectModel<typeof decisions>;
export type Task = InferSelectModel<typeof tasks>;
export type Issue = InferSelectModel<typeof issues>;
export type Conversation = InferSelectModel<typeof conversations>;
export type Message = InferSelectModel<typeof messages>;
export type WaitlistEntry = InferSelectModel<typeof waitlistEntries>;
export type Namespace = InferSelectModel<typeof namespaces>;
export type Org = InferSelectModel<typeof orgs>;
export type Memex = InferSelectModel<typeof memexes>;
export type User = InferSelectModel<typeof users>;
export type OrgMembership = InferSelectModel<typeof orgMemberships>;
export type DocMember = InferSelectModel<typeof docMembers>;
export type DocAssignee = InferSelectModel<typeof docAssignees>;
export type Tag = InferSelectModel<typeof tags>;
export type TagInsert = InferInsertModel<typeof tags>;
export type DocumentTag = InferSelectModel<typeof documentTags>;
export type DocumentTagInsert = InferInsertModel<typeof documentTags>;
export type InviteToken = InferSelectModel<typeof inviteTokens>;
export type OrgScaffoldAddition = InferSelectModel<typeof orgScaffoldAdditions>;
export type OrgScaffoldAdditionInsert = InferInsertModel<typeof orgScaffoldAdditions>;
export type ShareToken = InferSelectModel<typeof shareTokens>;
export type VerifiedDomain = InferSelectModel<typeof verifiedDomains>;
export type DomainVerificationToken = InferSelectModel<typeof domainVerificationTokens>;
export type NamespaceSlugReservation = InferSelectModel<typeof namespaceSlugReservations>;
export type OrgConsentResponse = InferSelectModel<typeof orgConsentResponses>;
export type AuthToken = InferSelectModel<typeof authTokens>;
export type McpToken = InferSelectModel<typeof mcpTokens>;
export type MemexEmissionKey = InferSelectModel<typeof memexEmissionKeys>;
export type MemexEmissionKeyInsert = InferInsertModel<typeof memexEmissionKeys>;
export type CliAuthRequest = InferSelectModel<typeof cliAuthRequests>;
export type Redirect = InferSelectModel<typeof redirects>;
export type UserSlackToken = InferSelectModel<typeof userSlackTokens>;
export type SlackUserCache = InferSelectModel<typeof slackUserCache>;
export type OAuthClient = InferSelectModel<typeof oauthClients>;
export type OAuthClientInsert = InferInsertModel<typeof oauthClients>;
export type OAuthAuthorizationCode = InferSelectModel<typeof oauthAuthorizationCodes>;
export type OAuthAuthorizationCodeInsert = InferInsertModel<typeof oauthAuthorizationCodes>;
export type OAuthRefreshToken = InferSelectModel<typeof oauthRefreshTokens>;
export type OAuthRefreshTokenInsert = InferInsertModel<typeof oauthRefreshTokens>;

// Codebase intelligence
export type Repo = InferSelectModel<typeof repos>;
export type RepoInsert = InferInsertModel<typeof repos>;
export type RepoScope = InferSelectModel<typeof repoScope>;
export type File = InferSelectModel<typeof files>;
export type FileInsert = InferInsertModel<typeof files>;
export type Symbol = InferSelectModel<typeof symbols>;
export type SymbolInsert = InferInsertModel<typeof symbols>;
export type Dependency = InferSelectModel<typeof dependencies>;
export type DependencyInsert = InferInsertModel<typeof dependencies>;
export type Call = InferSelectModel<typeof calls>;
export type CallInsert = InferInsertModel<typeof calls>;
export type Embedding = InferSelectModel<typeof embeddings>;
export type GuideContent = InferSelectModel<typeof guideContent>;
export type GuideContentInsert = InferInsertModel<typeof guideContent>;
export type RepoEndpoint = InferSelectModel<typeof repoEndpoints>;
export type RepoEndpointInsert = InferInsertModel<typeof repoEndpoints>;
export type RepoStructure = InferSelectModel<typeof repoStructure>;
export type RepoPattern = InferSelectModel<typeof repoPatterns>;
export type RepoDomain = InferSelectModel<typeof repoDomains>;
export type RepoTechStack = InferSelectModel<typeof repoTechStack>;
export type TestCoverage = InferSelectModel<typeof testCoverage>;
export type DecisionFileCoverage = InferSelectModel<typeof decisionFileCoverage>;
export type DriftSignal = InferSelectModel<typeof driftSignals>;
export type MissionRepo = InferSelectModel<typeof missionRepos>;

// Activity log (Pulse — b-60)
export type ActivityLog = InferSelectModel<typeof activityLog>;
export type ActivityLogInsert = InferInsertModel<typeof activityLog>;

// ══════════════════════════════════════
// MCP tool-call telemetry (drizzle/0062_add_mcp_tool_calls.sql)
// ══════════════════════════════════════
// One row per Mcp-Session-Id (the protocol's correlation token; the server
// stamps a UUID if the client didn't send one). Captures client identity
// once per session; last_seen_at refreshes on every call. See the migration
// header for capture policy and the spike notes that justified the schema.
export const mcpSessions = pgTable(
  "mcp_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientName: text("client_name"),
    clientVersion: text("client_version"),
    userAgent: text("user_agent"),
    clientInfo: jsonb("client_info"),
    ipAddress: inet("ip_address"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_sessions_user_id_started_at_idx").on(table.userId, table.startedAt),
    index("mcp_sessions_client_name_idx").on(table.clientName),
  ]
);

// One row per MCP tool invocation. user_id is denormalised off mcp_sessions
// by design so "what did user X do" stays a single-table scan; session_id
// keeps the link to client identity / IP. memex_id is captured from the
// tool's ctx resolvers (resolveMemex / resolveMemexFromEntity / resolveRef);
// org_id is derived from memex_id at insert time so "calls per org" stays
// a single-table scan after memex/namespace renames.
export const mcpToolCalls = pgTable(
  "mcp_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sessionId: text("session_id")
      .notNull()
      .references(() => mcpSessions.sessionId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Nullable — calls like list_memexes / get_information don't touch a
    // specific memex. Captured server-side from the tool's ctx resolvers.
    memexId: uuid("memex_id").references(() => memexes.id, { onDelete: "set null" }),
    // Derived from memex_id at insert time (NULL for personal-kind memexes
    // or calls where memex_id is itself NULL).
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "set null" }),
    toolName: text("tool_name").notNull(),
    argsJson: jsonb("args_json").notNull(),
    durationMs: integer("duration_ms").notNull(),
    error: text("error"),
    // Dev-only capture — gated by isDevMode() in services/telemetry.ts.
    // NULL in production until per-customer opt-in lands.
    resultText: text("result_text"),
    // spec-203 dec-3: the platform footer (everything after FOOTER_DELIMITER),
    // captured UNCONDITIONALLY (prod included) by splitting the result — never
    // the full tool output. NULL when the response carried no footer (non-Spec
    // docs, terse responses). The audit trail of exactly what guidance we inject.
    footerText: text("footer_text"),
  },
  (table) => [
    index("mcp_tool_calls_session_idx").on(table.sessionId, table.createdAt),
    index("mcp_tool_calls_user_idx").on(table.userId, table.createdAt),
    index("mcp_tool_calls_tool_error_idx").on(table.toolName, table.createdAt),
    index("mcp_tool_calls_memex_id_idx").on(table.memexId, table.createdAt),
    index("mcp_tool_calls_org_id_idx").on(table.orgId, table.createdAt),
  ]
);

export type McpSession = InferSelectModel<typeof mcpSessions>;
export type McpSessionInsert = InferInsertModel<typeof mcpSessions>;
export type McpToolCall = InferSelectModel<typeof mcpToolCalls>;
export type McpToolCallInsert = InferInsertModel<typeof mcpToolCalls>;

// ─────────────────────────────────────────────────────────────────────────────
// spec-200: "What's New" release-note feed.
//
// One GLOBAL, append-only feed (dec-3) — the prod-promoted Specs of
// memex-building-itself, identical for every user. Like guideContent there is
// deliberately NO memex_id / user_id column. Entries are auto-generated at the
// daily prod promotion (dec-1 fully-auto, dec-2 promotion-time), never
// regenerated once published (stable/citable — ac-9), and idempotent on
// sourceSpecRef (ac-6). Migration: drizzle/0080_add_whats_new_entries.sql.
// ─────────────────────────────────────────────────────────────────────────────
export const whatsNewEntries = pgTable(
  "whats_new_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Canonical ref of the source Spec — the generation idempotency key.
    sourceSpecRef: text("source_spec_ref").notNull(),
    // Display handle (e.g. "spec-192"), denormalised for cheap rendering.
    sourceSpecHandle: text("source_spec_handle").notNull(),
    // User-facing headline (benefit-led, not the raw Spec title).
    title: text("title").notNull(),
    // WHAT shipped (plain language).
    whatText: text("what_text").notNull(),
    // WHY it matters to users (plain language).
    whyText: text("why_text").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One entry per source Spec (ac-6 idempotency key).
    uniqueIndex("whats_new_entries_source_spec_ref_idx").on(table.sourceSpecRef),
    // Newest-first feed read (ac-11 ordering).
    index("whats_new_entries_published_at_idx").on(table.publishedAt),
  ]
);

export type WhatsNewEntry = InferSelectModel<typeof whatsNewEntries>;
export type WhatsNewEntryInsert = InferInsertModel<typeof whatsNewEntries>;

// spec-200 dec-7: persisted "judged not worth announcing" verdicts, so each Spec
// is evaluated exactly once (the candidate set excludes Specs in entries OR skips).
export const whatsNewSkips = pgTable(
  "whats_new_skips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceSpecRef: text("source_spec_ref").notNull(),
    sourceSpecHandle: text("source_spec_handle").notNull(),
    // The model's reason for skipping (debug / audit only).
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("whats_new_skips_source_spec_ref_idx").on(table.sourceSpecRef)]
);

export type WhatsNewSkip = InferSelectModel<typeof whatsNewSkips>;
export type WhatsNewSkipInsert = InferInsertModel<typeof whatsNewSkips>;
