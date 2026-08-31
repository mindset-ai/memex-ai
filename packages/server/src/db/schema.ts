import { pgTable, text, uuid, timestamp, integer, unique, uniqueIndex, check, primaryKey, jsonb, boolean, index, customType, doublePrecision, date, type AnyPgColumn } from "drizzle-orm/pg-core";
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

// std-32 (spec-122 dec-2) — the activity contract's load-bearing vocabularies.
// HOW (`channel`) = the surface a write arrived through; WHO-kind (`actor_kind`) =
// the class of actor behind it. These value lists are duplicated across every
// activity-bearing table's CHECK; hoisting them to one source keeps the allowed
// set authoritative and drift-proof. The fragment interpolates the table's own
// column so the emitted SQL stays byte-identical to the per-site originals.
//
// NOTE: comms_log.channel is a *notification* channel ('email','in_app',…) — a
// different vocabulary that intentionally does NOT use this helper.
const activityChannelCheck = (column: AnyPgColumn) =>
  sql`${column} IN ('rest_ui', 'mcp', 'in_app_agent', 'server')`;

const activityActorKindCheck = (column: AnyPgColumn) =>
  sql`${column} IN ('human', 'mcp_agent', 'in_app_agent', 'system')`;

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
  // spec-300 (dec-12): the dispatch key for Skills — extracted from SKILL.md
  // frontmatter `description:` at write time. Nullable: skills populate it, every
  // other docType leaves it null. `get_skill` reconstructs the verbatim SKILL.md
  // frontmatter from `title` (the SKILL.md `name`) + this column.
  description: text("description"),
  // spec-300 t-10 (dec-20): Memex-native capability flags authored ON a Skill —
  // `{ codebaseAccess, codeEditing, externalTools }`. These INFORM downstream
  // routing (which agent surface a Skill is offered to); they are NOT a security
  // boundary. Nullable: skills populate it at author time, every other docType
  // leaves it null. jsonb so the flag set can grow without a migration.
  skillCapabilities: jsonb("skill_capabilities").$type<{
    codebaseAccess: boolean;
    codeEditing: boolean;
    externalTools: boolean;
  }>(),
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
  // spec-521 (ac-2/ac-5/ac-12) — WHY a Spec was archived, and WHO archived it.
  //
  // `archived_at` alone made archive a black hole: the board hid the Spec and
  // nothing recorded the intent. The reason is the load-bearing fact — "absorbed
  // into spec-510" and "premise gone — voice loop removed" are the difference
  // between an archive and a disappearance — so it is asked for at archive time,
  // shown in the archive view, and served in the agent-facing stub.
  //
  // Capped at ARCHIVE_REASON_MAX_LENGTH (280) at the service layer, not by a DB
  // constraint: the cap exists so the stub cannot become a back door for the
  // content the archive is meant to withhold, and the service is where the
  // user-facing ValidationError belongs.
  //
  // archivedByName is the DENORMALISED display snapshot stamped at write per
  // std-32, so a later rename or user deletion can never rewrite historical
  // attribution. Mirrors the groundedBy{UserId,Name} pair below — same shape, and
  // like it (migration 0112) the provenance user id carries no FK.
  //
  // Phase-at-archive deliberately has NO column: archivedAt is orthogonal to
  // `status` (see above), so the phase a Spec was in when archived IS its
  // unchanged status, and restore is nulling archivedAt.
  archiveReason: text("archive_reason"),
  archivedByUserId: uuid("archived_by_user_id"),
  archivedByName: text("archived_by_name"),
  // spec-521 dec-5 (ac-15) — supersession, DOC-LEVEL ONLY.
  //
  // Answers the question archive cannot: "this shipped, and a later Spec changed
  // it." Archive means dead and withholds content; supersession withholds nothing
  // and only adds a pointer, which is why supersede_spec is agent-callable while
  // archiving stays human-only (dec-6).
  //
  // supersededAt NULL = not superseded, mirroring archivedAt's convention.
  // Many-to-one is allowed (several Specs may point at one successor) and chains
  // are legal, but CYCLES ARE REJECTED AT WRITE by walking the chain in the
  // service — there is no DB constraint that can express it.
  //
  // No decision, section or other child entity carries its own pointer (dec-5):
  // decision-level supersession would have to be honoured in all thirteen
  // decision read paths (agent/context-builder.ts among them, which builds the
  // in-app agent's Document Context), and a marker absent from even one of them
  // is worse than no marker.
  supersededByDocId: uuid("superseded_by_doc_id"),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  supersessionNote: text("supersession_note"),
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
  // spec-409 — the "code-grounded" flag: a Spec is grounded when an agent has
  // verified its resolved decisions against the actual codebase. Standalone
  // Spec-level boolean (dec-1) — NOT derived from per-node grounded_against
  // (spec-76 is draft, no code). Set only via the `ground_spec` MCP tool over
  // channel='mcp' with a `codebase_present` assertion (dec-3). Provenance is
  // stamped at write (dec-2): grounded_by_name is denormalised per std-32 so a
  // later rename can't rewrite history. Staleness is computed at read time
  // (decision/AC updated_at > grounded_at, dec-4) — never mutated here.
  groundedInCode: boolean("grounded_in_code").notNull().default(false),
  groundedAt: timestamp("grounded_at", { withTimezone: true }),
  groundedByUserId: uuid("grounded_by_user_id"),
  groundedByName: text("grounded_by_name"),
  // spec-535 dec-1 — the "sensitive" flag: this Spec is delicate or complex, so
  // talk to someone before changing it. Advisory ONLY: it refuses nothing, from
  // any channel (ac-3). It answers a question none of the three "who" relations
  // can — checked_out_by / doc_assignees / doc_members all say who is ON a Spec,
  // never whether it is DANGEROUS to touch, and that is not derivable from them.
  //
  // A column rather than a tag (dec-1): tags are a user-extensible {scope,value}
  // vocabulary, and a value the server cannot trust cannot back a guaranteed
  // warning. Deliberately NO reason column (ac-7) — this Memex is public
  // read-only and a "why is this dangerous" field is a leak surface (std-31);
  // a stale reason also misleads worse than a bare flag under-informs.
  //
  // sensitive_by_user_id IS the contact (dec-2): whoever raised the flag is who
  // to ask, so there is no separate steward field — that would be the fourth
  // "who" concept spec-506 dec-4 has an open question about. Provenance is
  // stamped at write; sensitive_by_name is the denormalised snapshot per std-32
  // so a rename can't rewrite history, and like grounded_by_user_id above the
  // provenance id carries no FK. Clearing the flag nulls all three (ac-9).
  sensitive: boolean("sensitive").notNull().default(false),
  sensitiveByUserId: uuid("sensitive_by_user_id"),
  sensitiveByName: text("sensitive_by_name"),
  // spec-371 rework (dec-5/dec-11/dec-12): the durable, single-holder CHECKOUT
  // record — NOT presence (which is ephemeral and untouched here). One current
  // holder per spec; the gate (dec-11) keys on checked_out_by + checked_out_at.
  // checked_out_thread is the Claude Code conversation UID (or "web"/null), the
  // join key for "return me to the conversation that worked on this spec" (dec-12).
  // FK lives in the migration SQL (mirrors created_by_user_id).
  checkedOutBy: uuid("checked_out_by"),
  checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
  checkedOutThread: text("checked_out_thread"),
  // spec-448 t-1 (document versioning): the doc's current version number. Starts
  // at 1 (no prior snapshot); bumped by the versioning service whenever it cuts a
  // new `document_versions` row. Lives on the doc row (not derived from
  // MAX(document_versions.version_number)) so callers can read "what version am I
  // on" with no join, and so a doc with zero snapshots still reports a real number.
  version: integer("version").notNull().default(1),
}, (table) => [
  unique("documents_memex_id_handle_unique").on(table.memexId, table.handle),
  index("documents_memex_id_idx").on(table.memexId),
  // spec-521 (ac-15) — serves the REVERSE supersession question the successor's
  // page asks ("what did I replace?") so the mirror line renders without a scan
  // of the Memex's documents. PARTIAL (WHERE NOT NULL) because the overwhelming
  // majority of rows are never superseded: smaller index, and no index entry
  // maintained on the write path for any ordinary doc. std-39 cl-18/cl-19/cl-25
  // reasoning is recorded in migration 0131.
  index("documents_superseded_by_doc_id_idx")
    .on(table.supersededByDocId)
    .where(sql`${table.supersededByDocId} IS NOT NULL`),
  // Per dec-3 of doc-10 the Spec rename (`review`→`plan`, `implementation`→`build`,
  // plus new `verify`) applies to docType='spec' rows only. Non-Spec docTypes keep
  // the legacy values, so this CHECK is the union of old + new and stays that way.
  // spec-181 (dec-2): the second phase renamed `plan`→`specify` (pipeline is now
  // draft → specify → build → verify → done) — migration 0078 flips the rows and
  // swaps 'specify' for 'plan' here. The legacy values (draft/review/implementation/
  // done/approved) stay because execution-plan rows still carry them.
  check("documents_status_valid", sql`${table.status} IN ('draft', 'review', 'implementation', 'done', 'approved', 'specify', 'build', 'verify')`),
]);

// spec-300 (dec-18/dec-19): auxiliary files bundled with a Skill document — the
// MANIFEST only. Auxiliary-file BYTES never live in Postgres (dec-19):
// `storage_kind='inline'` keeps small text in `text_content`; `storage_kind='bucket'`
// keeps `blob_uri` pointing at the StorageProvider (gcs/local/s3). `checksum` makes
// files content-addressed/immutable so a future document version (spec-448) can pin
// the exact bytes it had with no rework. `get_skill` returns these as a
// table-of-contents (path + purpose + content_type + size), never inline contents.
export const skillFiles = pgTable(
  "skill_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillDocId: uuid("skill_doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    // Relative path within the skill package (e.g. `templates/index.html`).
    path: text("path").notNull(),
    // Agent-facing one-line "use this when…" note; becomes the TOC entry so the
    // consuming agent knows when to fetch the file. Nullable, no backfill.
    purpose: text("purpose"),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    // Content hash — the immutability/versioning anchor (spec-448 forward-compat).
    checksum: text("checksum").notNull(),
    // 'inline' (text in text_content) | 'bucket' (bytes in blob store, path in blob_uri).
    storageKind: text("storage_kind").notNull(),
    textContent: text("text_content"),
    blobUri: text("blob_uri"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per (skill, path) — a skill can't carry the same path twice.
    unique("skill_files_doc_path_unique").on(table.skillDocId, table.path),
    index("skill_files_skill_doc_id_idx").on(table.skillDocId),
    // storage_kind is a closed set; keep it honest at the DB boundary.
    check("skill_files_storage_kind_valid", sql`${table.storageKind} IN ('inline', 'bucket')`),
  ],
);

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
    // spec-448 t-1 (document versioning): set to the doc's `version` at the
    // moment this section was soft-deleted/retired by a version cut, so a
    // restored-from-version rollback can tell "retired by this cut" apart from
    // "always active". NULL = never retired at a version boundary (the common
    // case — most soft-deletes happen outside any version-cut flow).
    retiredAtVersion: integer("retired_at_version"),
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
    // spec-122 dec-2/dec-5 — the activity contract (WHO + HOW). See acs above.
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name"),
    channel: text("channel"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "doc_sections_channel_valid",
      activityChannelCheck(table.channel),
    ),
    // `seq` is the allocate-once identity (spec-150 dec-2): minted as MAX(seq)+1 and
    // never reused, so a deleted section's frozen seq can't collide with a live one.
    // (Partial index retained from spec-107; the allocate-once allocator now provides
    // identity uniqueness. The resequencing display order moved to `position`.)
    uniqueIndex("doc_sections_doc_seq_unique")
      .on(table.docId, table.seq)
      .where(sql`status <> 'deleted'`),
    unique("doc_sections_doc_id_section_type_unique").on(table.docId, table.sectionType),
    // spec-352 (0105) — Home activity_view feed. doc_sections has no memex_id
    // (the view derives the tenant via a documents sub-select), so the Q-spark
    // arm reduces to doc_id IN (...) AND created_at >= window. Q-mine filters by
    // actor_user_id + window (partial: only attributable rows).
    index("doc_sections_doc_created_at_idx").on(table.docId, table.createdAt),
    index("doc_sections_actor_created_at_idx")
      .on(table.actorUserId, table.createdAt)
      .where(sql`${table.actorUserId} IS NOT NULL`),
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
    // spec-151 dec-5 — persisted testability classification. ONE verdict per clause,
    // so plain columns (not a join table like standard_clause_facets) per std-32's
    // load-bearing-→-column rule. NULL = not-yet-classified (the gap the backfill
    // fills). Named readers: the clause-coverage denominator reads is_obligation +
    // testable (only is_obligation && testable clauses count toward coverage); the
    // test-writing / verifying agents read archetype. `confidence` is deliberately
    // NOT persisted — a spike-only triage signal with no production reader.
    isObligation: boolean("is_obligation"),
    testable: boolean("testable"),
    archetype: text("archetype"),
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
    // spec-497 dec-3 (t-1) — the decision whose resolution TRIGGERED this drift
    // comment (distinct from decisionId, which is the comment's TARGET when a
    // comment is attached to a decision). Only ever set on drift comments, whose
    // target is a section; lets the knowledge-graph endpoint draw
    // decision→standard drift edges from a column, not from parsing the body.
    // ON DELETE SET NULL: a deleted decision degrades the edge to a badge, never
    // deletes the drift comment. NULL for pre-backfill history and for
    // human-observed drift with no single triggering decision.
    driftDecisionId: uuid("drift_decision_id")
      .references(() => decisions.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    // Attribution: author's user/namespace for external-comment rendering. external is
    // computed at render time as `author_namespace_id != memex.namespace_id` (the doc's
    // memex's namespace). Nullable for legacy comments without attribution.
    authorUserId: uuid("author_user_id"),
    authorNamespaceId: uuid("author_namespace_id"),
    // spec-122 dec-2/dec-5 — the activity contract's HOW. WHO already lives in
    // author_user_id / author_name; channel completes the contract so the
    // doc_comments arm of the activity view projects the same uniform shape.
    channel: text("channel"),
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
    // spec-320 (dec-1/dec-2): comment ASSIGNMENT (ownership). Single owner per
    // comment, so it lives on the row (a column), NOT a join table — the
    // cardinality is the inverse of doc_assignees (spec-118), where a Spec has
    // many assignees. The open→resolved lifecycle reuses resolved_at/resolution
    // (no assignment-specific status column). assigned_by / assigned_at are the
    // std-32 WHO/WHEN of the assignment, stamped at write. ON DELETE SET NULL so
    // removing a user keeps the comment (mirrors doc_assignees.assigned_by).
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    // spec-448 t-1 (document versioning): see doc_sections.retiredAtVersion —
    // same convention, applied to doc_comments.
    retiredAtVersion: integer("retired_at_version"),
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
    check(
      "doc_comments_channel_valid",
      activityChannelCheck(table.channel)
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
    // spec-320 (dec-2): the spec-315 "open assignments to me" read path —
    // assignee_user_id = :me AND resolved_at IS NULL. Partial so the index only
    // carries OPEN assignments (a resolved comment closes the assignment).
    index("doc_comments_open_assignee_idx")
      .on(table.assigneeUserId)
      .where(sql`${table.resolvedAt} IS NULL`),
    // spec-352 (0105) — Home activity_view feed. Q-spark covering composite
    // (memex_id, doc_id, created_at); Q-mine on author_user_id (this arm's WHO).
    index("doc_comments_memex_doc_created_at_idx").on(
      table.memexId,
      table.docId,
      table.createdAt,
    ),
    index("doc_comments_author_created_at_idx")
      .on(table.authorUserId, table.createdAt)
      .where(sql`${table.authorUserId} IS NOT NULL`),
    // spec-497 (t-1) — the knowledge-graph drift-edge query path: open drift
    // comments carrying a triggering-decision link, per memex. Partial so it
    // costs nothing for the (vast majority) non-drift comments.
    index("doc_comments_drift_decision_idx")
      .on(table.memexId, table.driftDecisionId)
      .where(sql`${table.driftDecisionId} IS NOT NULL AND ${table.resolvedAt} IS NULL`),
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
    // spec-448 t-1 (document versioning): see doc_sections.retiredAtVersion —
    // same convention, applied to decisions.
    retiredAtVersion: integer("retired_at_version"),
    // spec-122 dec-2/dec-5 — the activity contract (WHO + HOW). See acs above.
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name"),
    channel: text("channel"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("decisions_doc_id_seq_unique").on(table.docId, table.seq),
    index("decisions_memex_id_idx").on(table.memexId),
    // spec-352 (0105) — Home activity_view Q-spark covering composite. (Q-mine's
    // actor_user_id is already served by decisions_actor_user_id_idx, 0098.)
    index("decisions_memex_doc_created_at_idx").on(
      table.memexId,
      table.docId,
      table.createdAt,
    ),
    check(
      "decisions_channel_valid",
      activityChannelCheck(table.channel),
    ),
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
    // spec-448 t-1 (document versioning): see doc_sections.retiredAtVersion —
    // same convention, applied to tasks.
    retiredAtVersion: integer("retired_at_version"),
    // spec-122 dec-2/dec-5 — the activity contract (WHO + HOW). See acs above.
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name"),
    channel: text("channel"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("tasks_doc_id_seq_unique").on(table.docId, table.seq),
    index("tasks_memex_id_idx").on(table.memexId),
    // spec-352 (0105) — Home activity_view feed. Q-spark covering composite +
    // Q-mine actor index (tasks lacked an actor_user_id index before 0105).
    index("tasks_memex_doc_created_at_idx").on(
      table.memexId,
      table.docId,
      table.createdAt,
    ),
    index("tasks_actor_created_at_idx")
      .on(table.actorUserId, table.createdAt)
      .where(sql`${table.actorUserId} IS NOT NULL`),
    check(
      "tasks_channel_valid",
      activityChannelCheck(table.channel),
    ),
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
    // spec-391 dec-2 (0108): the reviewed-verification rationale — extends the
    // spec-188 acceptance overlay into a named, dated, REASONED sign-off so a
    // config/prose/Dashboard AC that cannot carry an automated test (Stripe
    // settings, Apple notarization, policy ACs) satisfies the hard verify→done
    // AC gate (dec-2) instead of permanently wedging the spec. Set together with
    // accepted_by/accepted_at by the reviewed-verification sign-off service;
    // NULL on a bare manual acceptance. The `accepted` verification state is
    // still driven by accepted_at; reviewed_reason is the human-facing "why".
    reviewedReason: text("reviewed_reason"),
    // spec-448 t-1 (document versioning): see doc_sections.retiredAtVersion —
    // same convention, applied to acs.
    retiredAtVersion: integer("retired_at_version"),
    // spec-122 dec-2/dec-5 — the activity contract (WHO + HOW), stamped at write
    // time so the activity view (dec-1) projects one uniform shape across every
    // arm. actor_name is denormalised so a later user rename/delete can't rewrite
    // historical attribution (ac-10). All nullable: backfill-free — unknown on
    // legacy rows and on any write that doesn't (yet) thread a RequestCtx.
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name"),
    channel: text("channel"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("acs_brief_id_seq_unique").on(table.briefId, table.seq),
    index("acs_memex_id_idx").on(table.memexId),
    index("acs_brief_id_idx").on(table.briefId),
    // spec-352 (0105) — Home activity_view Q-spark covering composite. (Q-mine's
    // actor_user_id is already served by acs_actor_user_id_idx, 0098.)
    index("acs_memex_brief_created_at_idx").on(
      table.memexId,
      table.briefId,
      table.createdAt,
    ),
    check(
      "acs_kind_valid",
      sql`${table.kind} IN ('scope', 'implementation')`,
    ),
    check(
      "acs_status_valid",
      sql`${table.status} IN ('proposed', 'active', 'rejected', 'superseded')`,
    ),
    // spec-122 dec-2 — channel is one of the four surfaces. NULL passes (a CHECK
    // is satisfied when its predicate is NULL), so legacy / unthreaded writes are
    // allowed while a stamped value is constrained to the contract's vocabulary.
    check(
      "acs_channel_valid",
      activityChannelCheck(table.channel),
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
    // spec-448 t-1 (document versioning): see doc_sections.retiredAtVersion —
    // same convention, applied to issues.
    retiredAtVersion: integer("retired_at_version"),
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
    // spec-151 dec-3: the tagged subject is a "verifiable subject" ref — an AC ref
    // OR a standard-clause ref (`…/standards/std-N/clauses/cl-N`). Renamed ac_uid →
    // subject_ref so the column name stops being an AC-specific misnomer (the old
    // name was a std-1-style partial-rename seam). Still a plain text ref, no FK.
    subjectRef: text("subject_ref").notNull(),
    // spec-398 dec-4 (ac-8): tenancy is a first-class column stamped at write,
    // resolved from the emitting Memex [per std-32] — no longer parsed out of
    // ac_uid at read time. The activity_view test_events arm filters this column
    // instead of the namespaces→memexes join that was the spec-396 leak surface
    // (migration 0109). The RLS POLICY itself is spec-399's [per std-36]; this
    // Spec adds the column + backfill + index only (ac-9, no RLS here).
    memexId: uuid("memex_id").notNull(),
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
    index("test_events_ac_uid_created_at_idx").on(table.subjectRef, table.createdAt),
    index("test_events_test_identifier_idx").on(table.testIdentifier, table.createdAt),
    // spec-352 (0105) — Home activity_view: the only prunable predicate on this
    // arm is the created_at window (the spec_ref join is a substring of ac_uid).
    index("test_events_created_at_idx").on(table.createdAt),
    // spec-398 dec-1/dec-2 (ac-1, ac-2): the keep-last-10-per-(ac_uid,
    // test_identifier) retention index — drives both the one-time rewrite-and-swap
    // and the steady-state trim-on-write, and doubles as the per-test timeline read.
    index("test_events_retention_idx").on(
      table.subjectRef,
      table.testIdentifier,
      table.createdAt,
    ),
    // spec-398 dec-5 (ac-11): the activity_view per-Spec arm filters te.memex_id;
    // this index turns that full Seq Scan into an index scan scoped to one tenant.
    index("test_events_memex_id_created_at_idx").on(
      table.memexId,
      table.createdAt,
    ),
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
    // spec-151 dec-3: renamed ac_uid → subject_ref (AC ref OR clause ref).
    subjectRef: text("subject_ref").notNull(),
    testIdentifier: text("test_identifier").notNull().default(""),
    latestStatus: text("latest_status").notNull(),
    latestRunAt: timestamp("latest_run_at", { withTimezone: true }).notNull(),
    runCount: integer("run_count").notNull().default(0),
    // spec-398 dec-4 (ac-8): tenancy column mirroring test_events [per std-32],
    // backfilled in the rewrite-and-swap migration. RLS is spec-399's (ac-9).
    memexId: uuid("memex_id").notNull(),
    // spec-520 dec-8 option A (migration 0137): the latest emission's PROVENANCE, so the
    // CI-origin audit survives t-12's retention window. The raw inputs rather than a
    // computed boolean, so the "is this CI" rule stays derivable if it ever changes.
    //
    // ⚠ latestMetadata NULL means "never observed", NOT "not CI". Rows predating 0137 have
    // no provenance to recover. From 0137 on, applyEmissionToSummary writes `{}` when an
    // emission carries no metadata, so NULL is unambiguous — and the audit must treat it as
    // UNKNOWN and skip, or every pre-existing AC reads as laptop-verified.
    latestRunId: text("latest_run_id"),
    latestMetadata: jsonb("latest_metadata").$type<Record<string, string> | null>(),
  },
  (table) => [
    primaryKey({ columns: [table.subjectRef, table.testIdentifier] }),
    check(
      "test_event_latest_status_valid",
      sql`${table.latestStatus} IN ('pass', 'fail', 'error')`,
    ),
  ]
);

// ══════════════════════════════════════
// AC first-verified (spec-398 t-6 / spec-125)
// ══════════════════════════════════════
//
// Durable "when did this AC first go green" fact, keyed by ac_uid. The analytics
// alignment-over-time curve (analytics.ts acsOverTime) needs the EARLIEST passing
// emission per ac_uid — but spec-398's keep-last-10 retention deletes that oldest
// row from test_events. This is the spec-125 operational/analytical tier split:
// test_events is the bounded OPERATIONAL tier; this table is the durable analytical
// snapshot retention never touches. Written by the emission path (recordFirstVerified,
// LEAST-wins so the earliest survives out-of-order writes); backfilled in 0110.
export const acFirstVerified = pgTable("ac_first_verified", {
  // spec-151 dec-3: renamed ac_uid → subject_ref (AC ref OR clause ref).
  subjectRef: text("subject_ref").primaryKey(),
  firstVerifiedAt: timestamp("first_verified_at", { withTimezone: true }).notNull(),
  // spec-520 dec-7 option C (migration 0136): the tenancy column this table never had.
  //
  // Without it the table could not carry an RLS policy at all, and its only reader scoped
  // by `subject_ref LIKE 'ns/mx/%'` — tenancy carried by a STRING, the spec-396 leak
  // pattern this Spec closes elsewhere. That, not the storage cost, was what was actually
  // wrong with this table.
  //
  // NULLABLE on purpose. Backfilled from test_event_latest; a subject_ref with no surviving
  // summary row (a discontinued AC, a deleted Spec) cannot be resolved, and dec-7's rule is
  // that such a row is ENUMERATED, never discarded — this table exists because first-green
  // dates were lost once already. Under RLS a NULL memex_id matches no tenant, so the row is
  // invisible to the product and fully visible to the owner role for inspection.
  memexId: uuid("memex_id"),
});

// ══════════════════════════════════════
// Per-day test-run rollup (spec-520 dec-5 / t-9)
// ══════════════════════════════════════
//
// The durable, analytical tier for the test-event firehose — spec-125's grain
// rule applied to it: declare the grain, then keep the counts instead of
// re-deriving them from rows we delete.
//
// Grain: one row per test, per subject, per UTC day.
//
// This exists because the history we believed we had did not exist. Retention
// trims raw `test_events` to a per-pair cap, so `testRunVolume` and
// `listAcAlignmentOverTime` counted rows that had already been deleted — and
// hardest for the busiest ACs, which are exactly the pairs that hit the cap.
// `ac_first_verified` is the same lesson learned once already and patched
// per-metric: it exists ONLY because retention destroyed the first-green date.
//
// Two properties are load-bearing and easy to break:
//
//   1. `memexId` is FIRST-CLASS and stamped at write [per std-32] — never
//      parsed back out of `subject_ref` at read time. That parse is the
//      spec-396 leak pattern (a real cross-org bleed, ~1.5M rows across 137
//      memexes) this Spec is closing elsewhere. It is also what makes the table
//      RLS-able, which `ac_first_verified` — `subject_ref` PK, no tenancy
//      column — structurally is not.
//
//   2. The count columns carry NO INDEX, deliberately [per std-39 cl-7]. These
//      are hot counter rows; an index on a count column defeats HOT updates and
//      every increment would then also write an index tuple. Do not add one to
//      make a chart faster — aggregate on the key columns instead.
//
// The CHECK is the wiring invariant: run_count must equal the three outcome
// counts summed. Each emission increments `run` and exactly one outcome, so a
// violation means the increment logic is wrong, and it says so on the first
// write rather than in a chart weeks later. A CHECK is not an index, so HOT
// still applies.
//
// NOTE: RLS is NOT enabled here yet. std-36 requires it for a tenancy-scoped
// table, and t-9 ac-3 demands it — but issue-8 must close first: the emission
// WRITE transaction (`routes/test-events.ts`, the `db.transaction` inside
// `mutate()`) does not run inside `runWithMemexId`, so a policy on this table
// would be unsatisfiable at write time and every emission would fail in prod
// while dev and CI stayed green (the owner role bypasses RLS). See issue-8.
export const testRunDaily = pgTable(
  "test_run_daily",
  {
    // spec-520 t-13 (ac-30): the cascading tenant FK migration 0134 omitted. Workspace
    // deletion reaches this table BY CONSTRUCTION, not by an enumeration someone
    // maintains — see drizzle/0139.
    memexId: uuid("memex_id")
      .notNull()
      .references(() => memexes.id, { onDelete: "cascade" }),
    subjectRef: text("subject_ref").notNull(),
    testIdentifier: text("test_identifier").notNull().default(""),
    // UTC calendar day the runs fall on. Derived from the event's own
    // created_at, never from the server's local clock.
    day: date("day").notNull(),
    runCount: integer("run_count").notNull().default(0),
    passCount: integer("pass_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.memexId, table.subjectRef, table.testIdentifier, table.day],
    }),
    check(
      "test_run_daily_counts_sum",
      sql`${table.runCount} = ${table.passCount} + ${table.failCount} + ${table.errorCount}`,
    ),
  ]
);

// ══════════════════════════════════════
// Document versioning (spec-448 t-1)
// ══════════════════════════════════════
//
// Two tables:
//   1. document_versions — an immutable, content-addressed snapshot of a Spec's
//      full artifact graph (sections + decisions + acs + tasks + issues +
//      comments) cut at a point in time. IMMUTABLE BY CONVENTION: no UPDATE
//      trigger is added here — the service layer simply never exposes an update
//      path (only INSERT + SELECT), mirroring facet_routing_log's append-only
//      posture.
//   2. doc_views — a per-user read-state marker recording the last version of a
//      doc a given user has viewed, so the UI can flag "N versions behind".
//
// Tenancy (std-36): document_versions carries a direct memex_id (denormalised,
// NOT an FK — same posture as every other tenant table) and gets the standard
// `document_versions_memex_isolation` policy (ENABLE, NOT FORCE — spec-257
// dec-1 / migration 0093). It is registered in RLS_TENANT_TABLES (rls-tables.ts)
// so the spec-440 context guard and the pg-policy-parity test both cover it.
//
// doc_views has NO memex_id (the spec's deliverable list omits it — a view
// marker is keyed purely on (user, doc)), so it does NOT join the memex_isolation
// family. Instead it gets its own exclusive `doc_views_owner_isolation` policy
// scoped on `app.user_id` (the same GUC spec-303's runWithUserId already sets,
// migration 0098) — a user can only ever read/write their OWN marker row. This
// is a genuinely new RLS shape (existing per-user tables like qa_report_views
// scope by memex_id and leave per-user scoping to the service layer); no
// existing precedent scopes a FOR ALL policy on app.user_id alone, so this is
// the first of its kind.
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    // Allocated per-doc: 1, 2, 3, ... matching documents.version at the moment
    // of the cut. UNIQUE(doc_id, version_number) below.
    versionNumber: integer("version_number").notNull(),
    // Human-facing label for the cut (e.g. "Pre-verify snapshot", or a
    // caller-supplied name). Required — the service layer defaults it when the
    // caller doesn't supply one.
    name: text("name").notNull(),
    // Content-addressed hash over the serialized `snapshot` — lets a caller
    // verify a restored snapshot's bytes are exactly what was cut, and lets two
    // versions be compared for identity without a deep-diff.
    checksum: text("checksum").notNull(),
    // The full artifact-graph snapshot: sections + decisions + acs + tasks +
    // issues + comments, as they stood at cut time. Shape is owned by the
    // service layer (versioned informally via the checksum), not enforced here.
    snapshot: jsonb("snapshot").notNull(),
    // Provenance for rollback: set when this version was itself produced by
    // restoring an earlier version, so the version history can show "restored
    // from v3" instead of looking like an ordinary forward cut. NULL for an
    // ordinary (non-restore) cut.
    restoredFromVersion: integer("restored_from_version"),
    // spec-122 dec-2/dec-5 — the activity contract (WHO + HOW). See acs above.
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name"),
    channel: text("channel"),
    // std-32 WHEN — the row's own timestamp (this IS "at": a version cut is a
    // one-shot immutable event, so createdAt fully serves that role; no separate
    // updatedAt exists because the row is never updated).
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("document_versions_doc_id_version_number_unique").on(table.docId, table.versionNumber),
    index("document_versions_memex_id_idx").on(table.memexId),
    index("document_versions_doc_id_idx").on(table.docId),
    check(
      "document_versions_channel_valid",
      activityChannelCheck(table.channel),
    ),
  ]
);

export const docViews = pgTable(
  "doc_views",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    // The highest documents.version the user has viewed. Compared against the
    // doc's current `version` (or the latest document_versions row) to derive
    // "N versions behind" in the UI — computed at read time, not stored.
    lastViewedVersion: integer("last_viewed_version").notNull(),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }).notNull(),
    // The surface the view was recorded through (std-32 HOW vocabulary). NOT
    // NULL here (unlike the activity-bearing tables' nullable channel) — every
    // doc_views write is a fresh, single, well-known call site with no legacy
    // rows to tolerate.
    channel: text("channel").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.docId] }),
    check(
      "doc_views_channel_valid",
      activityChannelCheck(table.channel),
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

// ══════════════════════════════════════
// Comment mentions (spec-320)
// ══════════════════════════════════════
//
// spec-320 (dec-1): @-mention a user in a comment. A JOIN TABLE because a single
// comment can call out SEVERAL people (multi-mention, ac-1) — the inverse
// cardinality of the single-owner assignee column on doc_comments. Tenancy on
// memex_id (NOT NULL, denormalised, mirrors doc_comments) for RLS. comment_id →
// doc_comments ON DELETE CASCADE (mentions die with their comment); user_id →
// users ON DELETE CASCADE (mentions die with the user). mentioned_by is the
// std-32 WHO (ON DELETE SET NULL so removing the actor keeps the mention); `at`
// is the std-32 WHEN. unique(comment_id,user_id) makes mention-add idempotent —
// one mention per user per comment. index(user_id) backs the spec-315
// "mentions-me" read path. The invariant assignee ⊆ mentions (dec-2) is enforced
// in the service layer: assigning a comment always writes the matching mention
// row, so comment_mentions is the uniform "everyone called out" set.
export const commentMentions = pgTable(
  "comment_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => docComments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mentionedBy: uuid("mentioned_by").references(() => users.id, { onDelete: "set null" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("comment_mentions_comment_id_user_id_unique").on(table.commentId, table.userId),
    index("comment_mentions_user_id_idx").on(table.userId),
    index("comment_mentions_comment_id_idx").on(table.commentId),
  ]
);

export const commentMentionsRelations = relations(commentMentions, ({ one }) => ({
  comment: one(docComments, {
    fields: [commentMentions.commentId],
    references: [docComments.id],
  }),
  user: one(users, {
    fields: [commentMentions.userId],
    references: [users.id],
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
    // Designated billing contact (spec-171 t-1). Nullable — null means payment emails
    // go to the org creator / all admins. Kept on the orgs table (not org_memberships)
    // so the billing contact can be a non-member (e.g. finance@company.com).
    billingContactName: text("billing_contact_name"),
    billingContactEmail: text("billing_contact_email"),
    // spec-171 t-2: enterprise trial state. null trial_status = never trialed or converted to paid.
    trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
    trialStatus: text("trial_status"),
    trialConvertedAt: timestamp("trial_converted_at", { withTimezone: true }),
    // Stripe customer ID — one per org, set on first purchase.
    stripeCustomerId: text("stripe_customer_id"),
    // spec-171 t-7: subscription state — kept in sync by stripe-webhook handler.
    stripeSubscriptionId: text("stripe_subscription_id"),
    planTier: text("plan_tier"),
    seatsPurchased: integer("seats_purchased"),
    // JSONB map of which trial nurture emails have been sent e.g. { day_1: true, day_4: true }.
    trialEmailsSent: jsonb("trial_emails_sent").$type<Record<string, boolean>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("orgs_namespace_id_unique").on(table.namespaceId),
    unique("orgs_stripe_customer_id_unique").on(table.stripeCustomerId),
    index("orgs_created_by_user_id_idx").on(table.createdByUserId),
    check("orgs_trial_status_valid", sql`${table.trialStatus} IN ('active', 'expired')`),
    check("orgs_plan_tier_valid", sql`${table.planTier} IN ('premium', 'enterprise', 'self-hosted-enterprise')`),
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
    // spec-500: the "featured demo" flag. When true AND visibility='public', this
    // memex is surfaced read-only in EVERY authenticated user's switcher (the
    // "Explore" group) via listMemberships' featured channel — no org membership
    // required, no membership row created (std-4 write-gate untouched). Purely a
    // listing signal: it is NOT wired to any metrics/exclusion filter (dec-8 keeps
    // the real memex-building-itself in analytics/live/usage). Defaults to false so
    // no memex is featured by the migration.
    isFeaturedDemo: boolean("is_featured_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // spec-474 dec-6: content-provisioning marker. NULL = the onboarding content seed
    // (default facets + Standards + the "Understanding Memex" starter Spec) has not yet
    // run. The seed moved OFF the signup request onto a first-load readiness endpoint
    // (POST /api/me/provision) the SPA drives behind a "Getting your Memex ready…"
    // blocker; this column is how the SPA knows whether to show it. Existing rows were
    // backfilled to now() by migration 0127 (they already carry their content).
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
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
  // spec-444: recorded whether a user had dismissed the first-run welcome-video gate.
  // spec-507 RETIRED that gate and its write path — nothing stamps this column now, and
  // no routing reads it. It survives as history (who was shown the video, pre-2026-07-24)
  // and to keep a Spec revert lossless; a future cleanup Spec may drop it. Null = the
  // column was never stamped for this user. (spec-508 dropped the sibling
  // onboarding_greeted_at column with the voice greeting — migration 0130.)
  videoWelcomedAt: timestamp("video_welcomed_at", { withTimezone: true }),
  // spec-305 dec-4/dec-5: the captured onboarding profile. roleCoords holds the
  // developer/designer/PM triangle as barycentric weights (sum 1); identityConfirmedAt
  // stamps when the user completed the journey's identity step (confirm name + place
  // the triangle, or skip to the centered default). needsOnboarding keys off this,
  // NOT !name — SSO users arrive with a name from Google/Microsoft but still take
  // the identity step.
  roleCoords: jsonb("role_coords").$type<{ dev: number; design: number; pm: number }>(),
  identityConfirmedAt: timestamp("identity_confirmed_at", { withTimezone: true }),
  // spec-427 t-4 (dec-5): lifecycle-email suppression. Null = subscribed; a timestamp =
  // the user unsubscribed from activation/win-back (lifecycle/broadcast) email via the
  // one-click List-Unsubscribe link. Scope is LIFECYCLE ONLY — transactional/auth email
  // and the spec-428 welcome ignore this flag and always send (ac-11 scope / ac-12).
  lifecycleEmailUnsubscribedAt: timestamp("lifecycle_email_unsubscribed_at", { withTimezone: true }),
  // spec-453 (dec-9/dec-10): the "See it verified" activation-email GATE SENTINEL,
  // NOT a true first-verify timestamp. Null = this user has never had an acceptance
  // criterion verified (and so is still eligible for the one-time milestone email);
  // a timestamp = the milestone has been consumed (email sent, or the user was a
  // pre-existing account backfilled to deploy-time at go-live so the back-catalog is
  // excluded — dec-10). Stamped once, atomically, on the first attributed `verified`
  // emission (never on a manual `accepted`). NO DEFAULT on purpose: a default would
  // auto-stamp every signup and make nobody eligible. Do NOT read this as analytics —
  // for backfilled rows it is deploy-time, not when they actually first verified.
  firstAcVerifiedAt: timestamp("first_ac_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("users_status_valid", sql`${table.status} IN ('active', 'disabled')`),
  unique("users_namespace_id_unique").on(table.namespaceId),
]);

// spec-260 t-1 (dec-6): per-user QA Reports read-state marker — the only net-new table
// for the QA Report feature. One row per (user, memex) holding the last time the user
// viewed the workspace QA Reports feed. Unread = count of qa_report* doc_sections in the
// memex created after `lastViewedAt` (computed in the service layer, not stored). A
// missing row means "never viewed" → every report counts.
//
// This is per-user state, NOT an activity-bearing doc table, so the std-32 activity-
// contract columns (actor_*, channel) deliberately do NOT apply. Tenancy: it carries a
// direct memex_id, so migration 0092 puts the same memex_isolation RLS policy on it as
// the Phase-2 tenant tables (0081); per-user scoping is enforced at the service layer,
// which always reads/writes the authenticated user's own row.
export const qaReportViews = pgTable(
  "qa_report_views",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    memexId: uuid("memex_id")
      .notNull()
      .references(() => memexes.id, { onDelete: "cascade" }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.memexId] })],
);

export type QaReportView = InferSelectModel<typeof qaReportViews>;
export type NewQaReportView = InferInsertModel<typeof qaReportViews>;

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

// Originating-session surrogate for the magic-link flow (spec-304 / embedded webview).
// When a magic link is requested from an embedded webview, the link is clicked in an
// EXTERNAL browser (different cookie jar), so the requesting webview never becomes
// authenticated. This row is a polling handle: the requesting client holds `id` (a
// high-entropy capability — it never sees the raw token) and polls the status endpoint.
// When the link is consumed elsewhere, `verifiedAt` is stamped against the row whose
// `tokenId` matches, and the next poll hands the requesting webview a session in-place.
//
// `id` yields a session once verified, so it is treated like a single-use token: short
// TTL (mirrors the magic_link token), only honoured while genuinely verified AND unexpired.
export const loginRequests = pgTable("login_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The auth_tokens row this poll-handle is the surrogate for. CASCADE so token cleanup
  // takes the surrogate with it.
  tokenId: uuid("token_id")
    .notNull()
    .references(() => authTokens.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  // Stamped when the magic link is consumed (in the external browser). NULL until then.
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  // Mirrors the magic_link token TTL — the capability is dead once this passes.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("login_requests_token_id_idx").on(table.tokenId),
]);

// spec-21 t-4: marketing attribution captured at account creation (first email verification).
// One row per new-account event; userId FK cascades so rows are deleted with the user.
export const userAttributions = pgTable("user_attributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Server-generated UUID used to deduplicate server-to-server conversion API calls.
  eventId: text("event_id").notNull(),
  gclid: text("gclid"),
  liFatId: text("li_fat_id"),
  oppref: text("oppref"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("user_attributions_user_id_idx").on(table.userId),
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
    // spec-418 dec-8: uniqueness is CASE-INSENSITIVE — a lower(scope), lower(value)
    // expression unique index (replacing spec-136's case-sensitive constraint), so a
    // case-variant (`API` vs `api`) can't fork a tag; display keeps the first writer's
    // casing. nullsNotDistinct is still essential: without it two flat `bug` tags
    // (scope = NULL → lower(scope) = NULL) would both be allowed (NULL <> NULL in a
    // default unique), defeating canonicalisation. NOTE: drizzle 0.45.2's index
    // builder can't express NULLS NOT DISTINCT (only the unique-CONSTRAINT builder
    // can), so the AUTHORITATIVE DDL — including `NULLS NOT DISTINCT` — lives in the
    // hand-written migration drizzle/0125_spec418_tag_case_fold.sql; this entry keeps
    // schema.ts honest about the index's name and expression columns (the
    // db-schema-drift gate diffs columns only).
    uniqueIndex("tags_memex_scope_value_ci_unique").on(
      table.memexId,
      sql`lower(${table.scope})`,
      sql`lower(${table.value})`,
    ),
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
    // spec-360 follow-up: ownership is additive — an addition is owned by an org
    // OR a personal namespace, enforced by the owner-XOR check below. org_id is
    // therefore NULLABLE now (a personal-owned row has org_id NULL +
    // namespaceId set).
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    // spec-360 follow-up: personal-namespace owner. NULL for org-owned rows; set
    // (with org_id NULL) for a personal namespace's own additions. ON DELETE
    // CASCADE mirrors the org cascade — deleting the namespace drops its rows.
    namespaceId: uuid("namespace_id").references(() => namespaces.id, {
      onDelete: "cascade",
    }),
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
    // spec-360 follow-up: owner-XOR — a row is owned by exactly one of an org or
    // a personal namespace. Mirrors migration 0107's CHECK constraint.
    check(
      "org_scaffold_additions_owner_xor",
      sql`(${table.orgId} IS NOT NULL) <> (${table.namespaceId} IS NOT NULL)`
    ),
    index("org_scaffold_additions_org_id_idx").on(table.orgId),
    // spec-360 follow-up: personal-owner read path mirrors the org pair — keep
    // `WHERE namespace_id = ? [AND (memex_id IS NULL OR = ?)]` an index scan.
    index("org_scaffold_additions_namespace_id_idx").on(table.namespaceId),
    index("org_scaffold_additions_namespace_id_memex_id_idx").on(
      table.namespaceId,
      table.memexId,
    ),
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
  memexId: uuid("memex_id")
    .notNull()
    .references(() => memexes.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
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
    // spec-234: the two-key model. Both columns are nullable and a NULL pair is
    // exactly today's permanent / CI key (human-minted, whole-memex, never
    // expires) — so existing rows keep working unchanged.
    //   expires_at         — when set, the key stops authorising emissions once
    //                        now() passes it (verifyEmissionKey gate), with no
    //                        human revoke. NULL = permanent. Agent keys set it
    //                        ~2h ahead (dec-1).
    //   scoped_spec_handle — when set, the key may ONLY emit for ACs of this Spec
    //                        (the `spec-N` handle from the ac_uid's
    //                        `/specs/<handle>/` segment, matched in the
    //                        /api/test-events gate). NULL = whole-memex
    //                        authorisation (the spec-129 default).
    // The pair is the discriminator the Settings UI reads (ac-8): ephemeral =
    // either column non-null. No separate `kind` column needed.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scopedSpecHandle: text("scoped_spec_handle"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("memex_emission_keys_memex_id_idx").on(table.memexId),
    index("memex_emission_keys_created_by_user_id_idx").on(table.createdByUserId),
  ]
);

// spec-371: the SCOPED HOOK CREDENTIAL — the least-privilege key the client-side
// checkout hook uses to authenticate its record-only phone-home (POST
// /api/spec-checkout/edit) and NOTHING else. Modeled on memex_emission_keys: the
// raw key `mxh_<base64url>` is stored only as a SHA-256 hash (`hashed_key`,
// unique-indexed for O(1) auth), and `prefix` keeps the leading chars for an
// `mxh_xxxxxxxx…` settings display (never the raw key, never the hash). Revoking
// sets `revoked_at` (rows are never hard-deleted, so the audit trail survives).
// Per-Memex: a key authorises edit reports for its OWN Memex only — and it is
// emphatically NOT the user's mxt_ PAT or rotating OAuth token (spec-371 dec-6),
// so a planted hook can fetch routing and report edits, nothing more.
export const memexHookKeys = pgTable(
  "memex_hook_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // spec-430 dec-1: NULL = USER-scoped (the key authorizes any memex its creator is
    // an active member of). A non-null value is a legacy per-memex key, additionally
    // pinned to that memex by the /api/spec-checkout authz. New keys mint NULL.
    memexId: uuid("memex_id").references(() => memexes.id, { onDelete: "cascade" }),
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
    index("memex_hook_keys_memex_id_idx").on(table.memexId),
    index("memex_hook_keys_created_by_user_id_idx").on(table.createdByUserId),
  ]
);

// spec-371: the RECORD-ONLY edit ledger + footprint join key (dec-8). One row per
// claimed-thread file edit reported by the checkout hook's phone-home: WHICH spec
// (memex_id + doc_id), WHICH thread (thread_uid = the agent's hook session id),
// WHAT changed (changed_paths), and the git footprint (commit_sha, branch) when
// available. High-frequency by design, so it is its OWN table — kept OUT of
// activity_log (the firehose), mirroring how test_event is not persisted there.
// Feeds the efficacy ledger (spec-125) and the commit/branch/thread links later
// specs hang off this. actor_user_id is the user the hook key resolved to.
export const specCheckoutEdits = pgTable(
  "spec_checkout_edits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id")
      .notNull()
      .references(() => memexes.id, { onDelete: "cascade" }),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    threadUid: text("thread_uid").notNull(),
    changedPaths: jsonb("changed_paths").$type<string[]>().notNull(),
    commitSha: text("commit_sha"),
    branch: text("branch"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("spec_checkout_edits_memex_doc_idx").on(table.memexId, table.docId),
    index("spec_checkout_edits_thread_uid_idx").on(table.threadUid),
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
    // spec-122 dec-2/dec-3 (ac-12) — the denormalised display snapshot, so an
    // activity_log row (the arm the view UNIONs for sourceless events: checkpoint
    // beats + status_changed) carries the full contract {actor_user_id, actor_name,
    // channel} and renders with no read-time join, surviving a later rename (ac-10).
    actorName: text("actor_name"),
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
      activityActorKindCheck(table.actorKind)
    ),
    check(
      "activity_log_channel_valid",
      activityChannelCheck(table.channel)
    ),
  ]
);

// ══════════════════════════════════════
// Usage events (spec-244) — product-engagement telemetry
// ══════════════════════════════════════
//
// The durable store for front-end engagement telemetry and whitelisted back-end
// outcomes. Deliberately SEPARATE from activity_log (spec-244 dec-1/§Architecture):
// activity_log is the audit history of what CHANGED; usage_events is the
// product-analytics feed of how people EXPERIENCE the product. Keeping them apart
// stops high-volume usage from bloating the audit log.
//
// Two writers (spec-244 dec-4/dec-8): the POST /telemetry route (front-end
// `track()` events, source='frontend') and a bus subscriber that mirrors
// whitelisted mutate() outcomes (source='backend'). The forwarder (spec-244 dec-3)
// tails this table — `forwarded_at` IS the outbox cursor: NULL until a row has been
// shipped to the analytics sink, then stamped, giving at-least-once delivery that
// survives a Cloud Run restart. `env` is the server-derived environment stamp
// (spec-244 dec-9) so int and prod never co-mingle at the sink boundary.
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tenancy scope. NULLABLE (spec-297 dec-1): most rows carry their real Memex,
    // but user-scoped funnel events that have no Memex by nature — account.created
    // (pre-Memex signup), mcp.connected (the handshake, before any tool names a
    // Memex), and mcp.tool_called for the Memex-agnostic tools (list_memexes /
    // get_information) — carry an honest NULL rather than a fabricated attribution.
    // memex_id is never forwarded to Mixpanel (toMixpanelEvent omits it), so this is
    // purely internal bookkeeping; the funnel keys on distinct_id. Extends spec-244's
    // original NOT NULL invariant, written before user-scoped events existed.
    memexId: uuid("memex_id").references(() => memexes.id, { onDelete: "cascade" }),
    // WHO (the acting Memex user). Nullable: anonymous capture is a no-op so a
    // null actor only arises for system-originated backend events.
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    // The anonymous-first identity join key (spec-254 dec-2). Plain uuid (no FK):
    // a denormalised join column on a high-volume table, and an anonymous event can
    // carry a visitor_id before any visitors row exists. The funnel joins this to visitors.
    // DORMANT-BY-DESIGN (spec-367 dec-5): the client mints no visitor_id since the
    // consent popup was retired, so this is ALWAYS NULL today. Retained — not removed —
    // to hold the door open for a future anonymous→user stitch (which re-introduces a
    // consent dialogue first, then resumes minting). Do not drop as dead code; no code
    // branches on it being populated.
    visitorId: uuid("visitor_id"),
    // The registered event name, e.g. 'spec.create_clicked' or 'document.created'.
    // Validated against the in-code registry before insert (spec-244 dec-5).
    name: text("name").notNull(),
    // Where the event was born: 'frontend' (track()) or 'backend' (whitelisted mutate()).
    source: text("source").notNull(),
    // Sanitised structured props — IDs / enums / counts only, NEVER content or
    // keystrokes (spec-244 §open-source-safe). jsonb, nullable.
    props: jsonb("props"),
    // Server-derived environment stamp (spec-244 dec-9). Unspoofable by the client.
    env: text("env").notNull(),
    // spec-458 dec-9 — coarse location from the GCLB geo header at telemetry
    // ingress, rounded to 1 decimal degree BEFORE persistence (services/geo.ts).
    // Chosen over presence for the human-side geo home because usage_events is
    // RLS-EXCLUDED (the /live global aggregate can read it) while presence is
    // RLS-scoped. Nullable: no header → no location.
    geoLat: doublePrecision("geo_lat"),
    geoLng: doublePrecision("geo_lng"),
    // When the event occurred. Defaults to insert time; the route may supply the
    // client-observed occurrence time for front-end events.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    // Outbox cursor (spec-244 dec-3). NULL = not yet forwarded to the sink.
    forwardedAt: timestamp("forwarded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Outbox tail: the forwarder scans undrained rows oldest-first. Partial index
    // on the unforwarded set so the scan stays tiny once most rows are drained.
    index("usage_events_unforwarded_idx")
      .on(table.occurredAt)
      .where(sql`${table.forwardedAt} IS NULL`),
    // SQL analytics + per-memex queries (rollout step one: queryable before any sink).
    index("usage_events_memex_id_occurred_at_idx").on(table.memexId, table.occurredAt),
    check("usage_events_source_valid", sql`${table.source} IN ('frontend', 'backend')`),
    check(
      "usage_events_env_valid",
      sql`${table.env} IN ('int', 'prod', 'local', 'test')`
    ),
  ]
);
export type UsageEvent = InferSelectModel<typeof usageEvents>;
export type UsageEventInsert = InferInsertModel<typeof usageEvents>;

// ══════════════════════════════════════
// Visitors — the anonymous-first identity spine (spec-254)
// ══════════════════════════════════════
//
// DORMANT-BY-DESIGN (spec-367 dec-5): the anonymous consent popup and the client
// visitor_id mint were retired (pre-signup capture is now identifier-less volume),
// so NOTHING writes to this table today — it stays empty. It is deliberately RETAINED
// (schema + the server reader visitorMiddleware/mergeVisitor) to hold the door open
// for a future anonymous→user stitch, which would re-introduce a consent dialogue
// first (PECR) and then resume minting. Do not remove as dead code.
//
// One durable id per browser, minted at first touch BEFORE any sign-in, persisted
// in a .memex.ai first-party cookie + localStorage mirror, and carried on every
// event. At sign-in the anonymous visitor_id MERGES into the now-known user (the
// analytics "identify" step): user_id + merged_at get stamped. This is the
// browser-only slice (spec-254 dec-2) and the embryo of spec-125's dim_actor —
// when 125's formal model lands, this table becomes or feeds it.
//
// The bind-once invariant (spec-254 dec-3): a visitor_id binds to at most one user,
// ever. Re-identifying the same user is a no-op; a merge that would re-point an
// already-bound id to a DIFFERENT user does NOT overwrite — the caller mints a
// fresh visitor_id instead. Erasure-reversible: nulling the row breaks the link
// without losing the anonymous arc (user delete → set null, not cascade).
export const visitors = pgTable(
  "visitors",
  {
    // The client-minted opaque id (crypto.randomUUID()); also the .memex.ai cookie value.
    visitorId: uuid("visitor_id").primaryKey(),
    // First time we saw this browser (pre-auth). Defaults to insert time.
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // WHO this visitor turned out to be, stamped at the identify merge. NULL while
    // still anonymous. set null on user delete keeps the visitor row.
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    // When the anon->known merge happened. NULL while still anonymous.
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Reverse lookup: every visitor id that resolved to a given user (per-user
    // journey reconstruction / cohort joins, spec-254 ac-3). Partial — only merged
    // rows carry a user_id, so the index stays small.
    index("visitors_user_id_idx").on(table.userId).where(sql`${table.userId} IS NOT NULL`),
  ]
);
export type Visitor = InferSelectModel<typeof visitors>;

// spec-6 (memex-backstage) t-1 — comms_log: the unified per-user record of every
// outbound communication to a user, across ALL channels (email / in-app / badge /
// OS), scheduled and sent. Core (memex-ai) OWNS + WRITES this public table;
// Backstage READS it cross-tenant via the memex_admin BYPASSRLS role and never
// writes it (spec-6 dec-5; the spec-280 admin↔public boundary). It is the single
// pane that lets ops see the TOTAL comms load on one human and avoid bombarding
// them — the whole point of the comms-strategy work.
//
// METADATA ONLY (spec-6 dec-4): a one-line subject/summary + status + timestamps +
// a source_ref pointer — NEVER the message body. Full content stays in the
// system-of-record (Postmark / HubSpot / the in-app notification store), reached
// via source_ref. Retention ~90 days, pruned core-side (spec-6 t-8).
//
// RLS — deliberately EXCLUDED, mirroring usage_events / visitors / activity_log
// (drizzle/0090 §exclusions). comms_log is a CROSS-TENANT, user-scoped comms
// dimension (keyed on user_id, NOT memex_id), written ADVISORILY from send paths
// that often run with no request ALS / tenant GUC (a background Activation send, a
// Postmark/Stripe delivery webhook) — a FORCE-RLS WITH CHECK would silently reject
// those inserts, and a memex_id USING clause is meaningless on a user-keyed row.
// The row holds only ids/enums/a summary line (no body, no credentials); isolation
// is enforced at the service layer and, in Backstage, by the requireOperator gate.
export const commsLog = pgTable(
  "comms_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // WHO the communication is addressed to (the single human). Cascade on user
    // delete: a user's comms history is erased with them — no orphan PII.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // WHICH channel it lands on. Badge + OS push are first-class alongside email +
    // in-app so the timeline reflects the TOTAL load on the user.
    channel: text("channel").notNull(),
    // WHAT kind of comm — coarse intent ('transactional' | 'activation' |
    // 'work_notification' | …) plus any sub-type. Free text so a new comm type
    // needs no migration; validated against the in-code registry before insert.
    type: text("type").notNull(),
    // Lifecycle. 'scheduled' = planned ahead, not yet sent (sent_at null); 'sent'
    // once dispatched; 'delivered'/'failed' applied later by delivery webhooks.
    status: text("status").notNull().default("sent"),
    // When the send is planned for (spec-6 dec-3). Set ahead for sends we control
    // (time-based Activation, Postmark scheduled); NULL for immediate-fire channels.
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    // When it actually went out. NULL while still scheduled.
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // One-line subject/summary for the timeline — NEVER the full body (dec-4).
    subject: text("subject"),
    // Pointer back to the system-of-record row (Postmark message id, HubSpot send
    // id, app notification id). Delivery webhooks match on this to update status.
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Per-user timeline: every comm to one human, newest first (spec-6 ac-1).
    index("comms_log_user_id_created_at_idx").on(table.userId, table.createdAt),
    // Cross-user schedule view: upcoming sends only, soonest first (spec-6 ac-4).
    // Partial on the unsent set so the scan stays tiny.
    index("comms_log_scheduled_idx")
      .on(table.scheduledFor)
      .where(sql`${table.sentAt} IS NULL`),
    check("comms_log_channel_valid", sql`${table.channel} IN ('email', 'in_app', 'badge', 'os')`),
    check(
      "comms_log_status_valid",
      sql`${table.status} IN ('scheduled', 'sent', 'delivered', 'failed')`,
    ),
  ],
);
export type CommsLogRow = InferSelectModel<typeof commsLog>;

// spec-12 (memex-backstage) t-1 — comms_event: one row per Postmark delivery /
// engagement event (Delivery / Open / Click / Bounce / SpamComplaint) for an
// already-logged email. The fidelity layer comms_log's thin sent|delivered|failed
// shadow lacks — it captures repeat opens/clicks, bounce type & reason, and powers
// the Comms page's per-message OUTCOME, drill-down fallback, and repeat/high-retry
// detection (dec-2). Core OWNS + WRITES it from the Postmark webhook (t-2); Backstage
// READS it cross-tenant via memex_admin and never writes it.
//
// LINK: commsLogId is a real FK (cascade) so the 90-day retention prune cascades
// these away with the parent; sourceRef (the Postmark MessageID) is denormalized as
// the webhook's join key (it only has the MessageID) AND the dedup discriminator.
//
// METADATA ONLY (dec-4): event type + bounce type/reason + timestamps — NEVER a body.
//
// IDEMPOTENT (dec-6): the (sourceRef, eventType, occurredAt) unique key lets the
// webhook write ON CONFLICT DO NOTHING; occurredAt is the Postmark event timestamp
// (not now()) so read-time recency/priority resolution is stable. RLS-EXCLUDED,
// mirroring comms_log (no RLS DDL) — written from the contextless webhook, read
// cross-tenant; see drizzle/0117 for the full justification.
export const commsEvent = pgTable(
  "comms_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The logged email this event belongs to. Cascade: pruning the comms_log row
    // (retention) takes its events with it — no orphans.
    commsLogId: uuid("comms_log_id")
      .notNull()
      .references(() => commsLog.id, { onDelete: "cascade" }),
    // The Postmark MessageID (= comms_log.source_ref). Denormalized: the webhook
    // matches on it (it has no row id), and it is the dedup discriminator.
    sourceRef: text("source_ref").notNull(),
    // Postmark RecordType — 'Delivery' | 'Open' | 'Click' | 'Bounce' |
    // 'SpamComplaint'. Free text (no CHECK) so a new Postmark event type needs no
    // migration; the webhook only writes the types it recognises.
    eventType: text("event_type").notNull(),
    // Postmark bounce Type (e.g. 'HardBounce' | 'SoftBounce' | 'SpamNotification');
    // null unless this is a Bounce/SpamComplaint event.
    bounceType: text("bounce_type"),
    // Postmark bounce Description / Details — the SMTP reason line; null otherwise.
    // A short reason string, never the message body.
    bounceReason: text("bounce_reason"),
    // The Postmark EVENT timestamp (DeliveredAt / BouncedAt / ReceivedAt …), NOT our
    // insert time — recency/priority outcome resolution and dedup both depend on it.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // When we recorded the event.
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // FK lookups + ON DELETE cascade. The source_ref join is served by the dedup
    // unique index below (it leads with source_ref), so no separate index for it.
    index("comms_event_comms_log_id_idx").on(table.commsLogId),
    // Idempotency (dec-6): a redelivered/duplicate Postmark event is ON CONFLICT
    // DO NOTHING. Leads with source_ref, so it doubles as the join index.
    unique("comms_event_dedup").on(table.sourceRef, table.eventType, table.occurredAt),
  ],
);
export type CommsEventRow = InferSelectModel<typeof commsEvent>;

export type VisitorInsert = InferInsertModel<typeof visitors>;

// ══════════════════════════════════════
// Experiments (spec-426) — a Backstage-owned A/B construct
// ══════════════════════════════════════
//
// The first operational slice of spec-109's hypothesis layer: state an intended
// outcome and A/B-test a change against it. Three platform-global tables —
// experiments → experiment_variants → experiment_assignments — owned + written by
// Core (memex-ai) and read CROSS-TENANT by Backstage via the memex_admin BYPASSRLS
// role (spec-279 / spec-280). They flow into the @mindset-ai/db-schema export.
//
// CROSS-TENANT, NOT memex-scoped — the "God agent associates ANY user with a
// variant" requirement is inherently cross-tenant, so these tables carry NO
// memex_id and sit OUTSIDE the per-tenant RLS policy of std-36. They follow the
// comms_log precedent (spec-6 dec-5; schema.ts above): user-keyed where they
// reference a principal, RLS-excluded, isolation enforced at the service layer and,
// in Backstage, by the requireOperator / isDevMode gate (routes/backstage.ts).
// RLS — deliberately EXCLUDED (see migration 0116); do NOT add a memex_id column or
// an ENABLE ROW LEVEL SECURITY clause to any table in this cluster.

// experiments — the experiment itself: a plain-language statement, a lifecycle
// status, and the outcome rule (the success predicate + a per-experiment window in
// DAYS, default 7 — dec-2; per-experiment, NOT a global constant).
export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stable human slug for the experiment (e.g. 'provisioning_demo_vs_starter').
    // Unique so code + Backstage can look an experiment up by a stable key.
    key: text("key").notNull().unique(),
    // The "we think X moves Y because Z" prose (spec-109's hypothesis form).
    statement: text("statement").notNull(),
    // Lifecycle: draft → running → concluded. Concluding is a HUMAN call in
    // Backstage (spec-109: agent proposes, human validates), never an auto trip.
    status: text("status").notNull().default("draft"),
    // The success predicate as structured data (e.g. which milestone decides the
    // verdict). Decorative shape lives here; the load-bearing window is its own
    // first-class column below (std-32).
    outcomeRule: jsonb("outcome_rule").$type<Record<string, unknown>>(),
    // The success window N in DAYS — per-experiment, default 7 (dec-2). First-class
    // column (not buried in outcome_rule jsonb) because the 3-hourly verdict sweep
    // reads it on every pass to decide succeeded vs failed (std-32: load-bearing
    // fields are columns).
    windowDays: integer("window_days").notNull().default(7),
    // WHO authored the experiment (std-32). Denormalised name stamped at write so a
    // later rename can't rewrite history. set null on user delete keeps the row.
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("experiments_status_valid", sql`${table.status} IN ('draft', 'running', 'concluded')`),
    check("experiments_window_days_positive", sql`${table.windowDays} > 0`),
  ],
);
export type Experiment = InferSelectModel<typeof experiments>;
export type ExperimentInsert = InferInsertModel<typeof experiments>;

// experiment_variants — the arms (A = control / B = treatment). Each carries a
// behaviour id into a CODE-SIDE registry (dec-4): 'handhold_demo' → the fixed demo,
// 'starter_spec' → the seeded "Understanding Memex" spec. An unknown id falls back
// to control rather than failing signup.
export const experimentVariants = pgTable(
  "experiment_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascade: a variant has no meaning without its experiment.
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    // The arm key — 'A' (control) or 'B' (treatment).
    key: text("key").notNull(),
    // Short human label for Backstage display (e.g. "Handhold demo walkthrough").
    label: text("label").notNull(),
    // Long-form A/B narrative — what this arm actually does, in prose. Stored on the
    // arm (not just the short label) so Backstage's Experiments tab can show an A-vs-B
    // summary without re-deriving it from the behaviour id. Nullable: an ad-hoc
    // experiment may carry only a label.
    description: text("description"),
    // Exactly one arm should be the control; the unknown-behaviour fallback resolves
    // to it (dec-4).
    isControl: boolean("is_control").notNull().default(false),
    // Short behaviour id into the code-side registry (dec-4). Free-ish but
    // CHECK-constrained to the known set so a bad seed is caught early.
    behaviour: text("behaviour").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per (experiment, arm key).
    uniqueIndex("experiment_variants_experiment_key_unique").on(table.experimentId, table.key),
    index("experiment_variants_experiment_id_idx").on(table.experimentId),
    check("experiment_variants_key_valid", sql`${table.key} IN ('A', 'B')`),
    check(
      "experiment_variants_behaviour_valid",
      sql`${table.behaviour} IN ('handhold_demo', 'starter_spec')`,
    ),
  ],
);
export type ExperimentVariant = InferSelectModel<typeof experimentVariants>;
export type ExperimentVariantInsert = InferInsertModel<typeof experimentVariants>;

// experiment_assignments — user ↔ variant ↔ time, plus who/what assigned it, plus
// the decided verdict inline. The auto assignment is a deterministic hash(user_id)
// → 50/50 split at provisioning (dec-6), recorded and agent-overridable. One ACTIVE
// (superseded_at IS NULL) assignment per (user, experiment); a reassignment
// supersedes the prior row, retaining history (spec-109 wants who-was-on-what-when).
export const experimentAssignments = pgTable(
  "experiment_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => experimentVariants.id, { onDelete: "cascade" }),
    // WHO is assigned. Cascade on user delete: a user's assignment history is erased
    // with them — no orphan principal references (mirrors comms_log).
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    // HOW the assignment was made (std-32 channel): 'auto' = the deterministic
    // provisioning split, 'operator' = a human in Backstage, 'agent' = the God
    // agent. A missing channel is a defect, never a silent default — NOT NULL.
    assignedBy: text("assigned_by").notNull(),
    // The principal behind an 'operator'/'agent' assignment, if any. NULL for 'auto'.
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Why a non-auto (re)assignment was made — free text for the audit trail.
    reason: text("reason"),
    // Set when this assignment is superseded by a reassignment. NULL = the single
    // ACTIVE assignment for this (user, experiment).
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    // The decided verdict, stamped inline by the 3-hourly sweep (dec-1). Memex
    // TALLIES these decided booleans; it never computes analytics over a firehose.
    outcome: text("outcome").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    index("experiment_assignments_user_id_idx").on(table.userId),
    index("experiment_assignments_experiment_id_idx").on(table.experimentId),
    // Enforce ONE active assignment per (user, experiment). Partial on the
    // not-superseded set so superseded history rows don't collide.
    uniqueIndex("experiment_assignments_active_user_experiment_unique")
      .on(table.userId, table.experimentId)
      .where(sql`${table.supersededAt} IS NULL`),
    check(
      "experiment_assignments_assigned_by_valid",
      sql`${table.assignedBy} IN ('auto', 'operator', 'agent')`,
    ),
    check(
      "experiment_assignments_outcome_valid",
      sql`${table.outcome} IN ('pending', 'succeeded', 'failed')`,
    ),
  ],
);
export type ExperimentAssignment = InferSelectModel<typeof experimentAssignments>;
export type ExperimentAssignmentInsert = InferInsertModel<typeof experimentAssignments>;

// ══════════════════════════════════════
// Presence (spec-122 dec-4)
// ══════════════════════════════════════
//
// The ephemeral "who's here now" plane — present-tense and decaying, NOT a
// durable log. A row counts as "here" when last_seen_at is within the decay
// window (~30s); the presence service prunes / ignores older rows. Distinct
// from activity_log on purpose: activity is what CHANGED (durable), presence is
// who is THERE (ephemeral). Writers upsert a single row per
// (doc_id, actor_user_id, channel, client_id) and bump last_seen_at on each
// beat — built writer-agnostic so the deferred checkpoint feed (spec-132, dec-9)
// slots in additively alongside the passive-telemetry floor and the browser
// heartbeat. Tenancy-scoped (memex_id) but written by heartbeats, so per std-8
// it is silent-allowed: no UI subscriber cares about last_seen_at drift, the
// Pulse "Working now" zone reads it directly.
export const presence = pgTable(
  "presence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id")
      .notNull()
      .references(() => memexes.id, { onDelete: "cascade" }),
    // The spec the actor is present IN (the "where"). FK to documents so a
    // deleted spec drops its presence rows.
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    // Presence always resolves to a known user: the browser heartbeat carries the
    // authenticated session user, and the passive agent floor carries
    // mcp_sessions.user_id (NOT NULL). ON DELETE CASCADE — presence is ephemeral,
    // a deleted user simply stops being "here".
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Denormalised display name (user.name ?? email), same posture as the
    // activity contract: the "Working now" line renders with no read-time join.
    actorName: text("actor_name"),
    actorKind: text("actor_kind").notNull(),
    channel: text("channel").notNull(),
    // The per-client discriminator (MCP session id / browser session id). NOT
    // NULL DEFAULT '' so the upsert conflict target never sees a NULL (which
    // Postgres treats as distinct, defeating the upsert). Multiple sessions of
    // the same user on the same spec are distinct presence rows.
    clientId: text("client_id").notNull().default(""),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per (doc, actor, channel, client) — the upsert conflict target.
    unique("presence_doc_actor_channel_client_unique").on(
      table.docId,
      table.actorUserId,
      table.channel,
      table.clientId,
    ),
    // The "who's here in this spec, recently" read path: filter by doc, order by
    // recency, drop rows past the decay window.
    index("presence_doc_id_last_seen_at_idx").on(table.docId, table.lastSeenAt),
    // The Memex-wide "Working now" sweep across all specs.
    index("presence_memex_id_last_seen_at_idx").on(table.memexId, table.lastSeenAt),
    check(
      "presence_actor_kind_valid",
      activityActorKindCheck(table.actorKind),
    ),
    check(
      "presence_channel_valid",
      activityChannelCheck(table.channel),
    ),
  ]
);

// ══════════════════════════════════════
// Facets (spec-340 — the inert foundation, phase 1)
// ══════════════════════════════════════

// The facet vocabulary (spec-340 dec-7). A closed per-owner set of cross-cutting
// practice areas (security, db-migrations, e2e-testing, …); each owner gets its own
// editable copy of the default 16, seeded at provisioning (t-2/t-3).
//
// Owner is POLYMORPHIC (dec-7): `ownerType` ∈ {org, memex} + `ownerId`. An
// org-owned memex shares its org's vocabulary (ownerType='org', ownerId=org.id, per
// std-4); a personal memex with no owning org carries its own (ownerType='memex',
// ownerId=memex.id). This supersedes the original org_id-only model so personal
// memexes — which are NOT modelled as their own org — still get a vocabulary.
// `ownerId` is intentionally NOT a foreign key (it points at one of two tables);
// referential integrity for the org case is enforced by the seeding paths, not the
// schema. Owner-config posture like org_scaffold_additions — NO memex_id, so NO
// memex_isolation RLS (a row could never satisfy a memex_id=GUC predicate); access
// is gated at the service layer by owner resolution + membership.
export const facets = pgTable(
  "facets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerType: text("owner_type").notNull(),
    ownerId: uuid("owner_id").notNull(),
    // Stable slug — the code/prompt/LLM anchor AND the pill label by default.
    // Clause tags (and, in phase 2, ballots) anchor on this; a display rename never
    // rewrites it (dec-5).
    key: text("key").notNull(),
    // Renameable display override; the pill shows name ?? key.
    name: text("name"),
    // REQUIRED disambiguating rubric the classifier reads (dec-7) — never null.
    description: text("description").notNull(),
    // Advisory display order.
    ord: integer("ord").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Per-owner uniqueness — two owners may diverge under the same key (dec-7).
    unique("facets_owner_key_unique").on(table.ownerType, table.ownerId, table.key),
    index("facets_owner_idx").on(table.ownerType, table.ownerId),
    check("facets_owner_type_valid", sql`${table.ownerType} IN ('org', 'memex')`),
  ],
);

// Clause→facet tags (spec-340 dec-2/dec-8) — assigned by the agent-driven classifier
// (local backfill in phase 1; NOT a hand-maintained join — the distinction the
// spec-193 guard reconciliation rides, t-7). Memex-scoped (rides the standards
// corpus). The tri-state the design requires is encoded by the nullable facet_id:
//   • NO rows for a clause            → not-yet-classified
//   • exactly one row, facet_id NULL  → explicit "governs nothing"
//   • one row per member facet         → governs those facets
// Standard-level pills are the union over member rows only.
export const standardClauseFacets = pgTable(
  "standard_clause_facets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    clauseId: uuid("clause_id")
      .notNull()
      .references(() => standardClauses.id, { onDelete: "cascade" }),
    // NULL = the explicit "governs nothing" marker, distinguishable from no rows.
    facetId: uuid("facet_id").references(() => facets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // At most one membership row per (clause, facet).
    uniqueIndex("standard_clause_facets_clause_facet_unique")
      .on(table.clauseId, table.facetId)
      .where(sql`${table.facetId} IS NOT NULL`),
    // At most one explicit-none marker per clause.
    uniqueIndex("standard_clause_facets_clause_none_unique")
      .on(table.clauseId)
      .where(sql`${table.facetId} IS NULL`),
    index("standard_clause_facets_clause_id_idx").on(table.clauseId),
    index("standard_clause_facets_facet_id_idx").on(table.facetId),
    index("standard_clause_facets_memex_id_idx").on(table.memexId),
  ],
);

// ── Facet consume-side: ballots + routing log (spec-423 phase 2) ──────────────
// Bespoke per-noun ballot tables (dec-7). Each carries the COMPLETE boolean verdict
// map keyed on facet slug + an explicit `none` flag + a `vocabulary_keys` snapshot
// (completeness judged at cast time) + std-32 actor stamping + memex_id (ENABLE-not-
// FORCE RLS, std-36). Ballots anchor on facet KEYS (strings), never owner ids, so
// they stay owner-model-agnostic across spec-340's polymorphic owner.
export const taskFacetBallots = pgTable(
  "task_facet_ballots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    // Complete boolean map keyed on facet slug (full map, not sparse).
    verdict: jsonb("verdict").notNull().$type<Record<string, boolean>>(),
    // Explicit "this work governs no facet" — honest no-facet work.
    none: boolean("none").notNull().default(false),
    // Slugs the ballot was cast against — completeness judged at cast time (dec-7).
    vocabularyKeys: jsonb("vocabulary_keys").notNull().$type<string[]>(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name"),
    channel: text("channel"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One ballot per task (upsert target).
    unique("task_facet_ballots_task_id_unique").on(table.taskId),
    index("task_facet_ballots_memex_id_idx").on(table.memexId),
  ],
);

// dec-6: a decision's ballot is a WORK-SIDE routing hook only — it routes the
// governing STANDARDS, and is NEVER surfaced as binding precedent.
export const decisionFacetBallots = pgTable(
  "decision_facet_ballots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => decisions.id, { onDelete: "cascade" }),
    verdict: jsonb("verdict").notNull().$type<Record<string, boolean>>(),
    none: boolean("none").notNull().default(false),
    vocabularyKeys: jsonb("vocabulary_keys").notNull().$type<string[]>(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name"),
    channel: text("channel"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("decision_facet_ballots_decision_id_unique").on(table.decisionId),
    index("decision_facet_ballots_memex_id_idx").on(table.memexId),
  ],
);

// Append-only routing telemetry (dec-4). One row per routing call on create_task /
// resolve_decision: query, the full candidate set with ALL scores + surfaced flag,
// the top-K cut, ranker provenance, owning ref, timestamp. OFF the SSE bus
// (telemetry-log posture, std-8 silent-allowed). The substrate to tune K and
// rebuild a clean relevance gold set from real traffic.
export const facetRoutingLog = pgTable(
  "facet_routing_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memexId: uuid("memex_id").notNull(),
    ownerRef: text("owner_ref").notNull(),
    noun: text("noun").notNull(),
    queryText: text("query_text").notNull(),
    facetKeys: jsonb("facet_keys").notNull().$type<string[]>(),
    candidates: jsonb("candidates")
      .notNull()
      .$type<Array<{ handle: string; title: string; score: number; surfaced: boolean }>>(),
    k: integer("k").notNull(),
    rankerModel: text("ranker_model").notNull(),
    rankerParams: jsonb("ranker_params").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("facet_routing_log_memex_id_idx").on(table.memexId),
    index("facet_routing_log_created_at_idx").on(table.createdAt),
  ],
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
export type SkillFile = InferSelectModel<typeof skillFiles>;
export type SkillFileInsert = InferInsertModel<typeof skillFiles>;
export type StandardClause = InferSelectModel<typeof standardClauses>;
export type Facet = InferSelectModel<typeof facets>;
export type FacetInsert = InferInsertModel<typeof facets>;
export type StandardClauseFacet = InferSelectModel<typeof standardClauseFacets>;
export type StandardClauseFacetInsert = InferInsertModel<typeof standardClauseFacets>;
export type ClauseRef = InferSelectModel<typeof clauseRefs>;
export type ClauseRefInsert = InferInsertModel<typeof clauseRefs>;
export type DocComment = InferSelectModel<typeof docComments>;
export type CommentMention = InferSelectModel<typeof commentMentions>;
export type CommentMentionInsert = InferInsertModel<typeof commentMentions>;
export type Decision = InferSelectModel<typeof decisions>;
export type Task = InferSelectModel<typeof tasks>;
export type Issue = InferSelectModel<typeof issues>;
export type DocumentVersion = InferSelectModel<typeof documentVersions>;
export type DocumentVersionInsert = InferInsertModel<typeof documentVersions>;
export type DocView = InferSelectModel<typeof docViews>;
export type DocViewInsert = InferInsertModel<typeof docViews>;
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
export type LoginRequest = InferSelectModel<typeof loginRequests>;
export type McpToken = InferSelectModel<typeof mcpTokens>;
export type MemexEmissionKey = InferSelectModel<typeof memexEmissionKeys>;
export type MemexEmissionKeyInsert = InferInsertModel<typeof memexEmissionKeys>;
export type MemexHookKey = InferSelectModel<typeof memexHookKeys>;
export type SpecCheckoutEdit = InferSelectModel<typeof specCheckoutEdits>;
export type SpecCheckoutEditInsert = InferInsertModel<typeof specCheckoutEdits>;
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
    // spec-458 dec-9 — coarse location from the GCLB geo header, rounded to
    // 1 decimal degree BEFORE persistence (services/geo.ts). Nullable: traffic
    // that bypasses the LB (local dev, direct Cloud Run) carries no header.
    geoLat: doublePrecision("geo_lat"),
    geoLng: doublePrecision("geo_lng"),
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
    // spec-538 t-1 (ac-22, issue-1): the footer's TRUE length before any clipping.
    // footer_text is capped so a pathological payload can't wedge the row; without
    // this, a clipped row is indistinguishable from a short one in aggregate — which
    // is how spec-538 dec-2 came to understate the envelope's worst case by ~7k, and
    // how spec-510 ac-6's measurement gate is biased against its own promise.
    // Clipped ⇔ footer_text_length > length(footer_text). NULL = no footer injected
    // (and NULL for pre-spec-538 rows, deliberately not backfilled).
    footerTextLength: integer("footer_text_length"),
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
// memex-building-itself, identical for every user. There is
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

// ── spec-171 t-2: enterprise schema (hosted-only) ────────────────────────────
// Self-hosted tables (org_llm_keys, self_hosted_licenses, license_checkins) are
// deferred to spec-323.

// Idempotency log for Stripe webhook handlers. Unique on event_id prevents
// double-processing on webhook retries (dec-8).
export const stripeEvents = pgTable(
  "stripe_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("stripe_events_event_id_unique").on(table.eventId),
  ]
);

export type StripeEvent = InferSelectModel<typeof stripeEvents>;
export type StripeEventInsert = InferInsertModel<typeof stripeEvents>;

// ── spec-349: cross-instance auth rate-limit store ───────────────────────────
// Backs services/auth-rate-limit.ts. The in-memory Map it replaced multiplied
// every limit by the Cloud Run instance count (3) and reset on cold start
// (spec-345 perf-3). One row per (scope, key); the limiter increments it with a
// single atomic INSERT ... ON CONFLICT DO UPDATE so concurrent instances
// serialise on the row lock. NOT tenant-scoped (keys are IP / email / user-id),
// so no RLS — see migration 0105.
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key] }),
    index("rate_limit_counters_reset_at_idx").on(table.resetAt),
  ]
);

export type RateLimitCounter = InferSelectModel<typeof rateLimitCounters>;
export type RateLimitCounterInsert = InferInsertModel<typeof rateLimitCounters>;
