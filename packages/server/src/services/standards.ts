// ── Standards (t-10 / doc-10 Slice 4) ───────────────────────
// Per dec-3, dec-14, dec-15, dec-17, dec-18: standards are ordinary documents with
// docType='standard'. No new tables — they reuse `documents`, `doc_sections`, and
// `doc_comments` (drift flags are typed comments with comment_type='drift').
//
// What's here:
//   - listStandards / getStandard              — read helpers (no docType-elsewhere logic)
//   - createStandard                            — author a new standard with sections
//   - updateStandardByInstruction               — agent-driven content edit (records the
//                                                  instruction as a discussion comment so
//                                                  there's an audit trail; the actual edit
//                                                  flows through update_section in the
//                                                  agent's existing pipeline)
//   - flagDrift                                  — post a typed comment (comment_type='drift',
//                                                  source='agent') against a section of a
//                                                  standard. Source is server-stamped per
//                                                  the t-4 contract — callers can't override.
//   - findStandardsAffectedByDecision           — Postgres FTS (to_tsvector +
//                                                  plainto_tsquery) over doc_sections.content
//                                                  in this account's standards, looking for
//                                                  `[per dec-N]` references. Used by t-13's
//                                                  decision-triggered staleness flow.
//
// All helpers are account-scoped. Cross-account leakage is prevented at the query level —
// every read joins to documents.account_id = $1, every drift comment carries account_id.

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  docSections,
  docComments,
  decisions,
  standardClauses,
} from "../db/schema.js";
import type { Doc, DocSection, DocComment, StandardClause } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { nextStandardHandle } from "./documents.js";
import { addComment } from "./comments.js";
import { DOC_TYPES, type DocType } from "../types/roles.js";
import { embedAndStoreDoc } from "./memex-embeddings.js";
import { withSeqRetry } from "./shared/sequence.js";

// Hard-pin the docType locally so any future renames flow through one place. Keeps the
// service decoupled from string literals scattered across callers.
const STANDARD_DOC_TYPE: DocType = DOC_TYPES[1]; // 'standard' — guarded by the union
if (STANDARD_DOC_TYPE !== "standard") {
  // Defensive — DOC_TYPES is the source of truth and this should always be 'standard'.
  throw new Error(
    `Unexpected DOC_TYPES[1] (${STANDARD_DOC_TYPE}); standards service expects 'standard'.`,
  );
}

// ── Types ────────────────────────────────────────────

export interface StandardSectionInput {
  /** Conventionally `do`, `dont`, `verify`, `overview`, `rule-1`, etc. — free-form. */
  sectionType: string;
  title?: string;
  /** Markdown body. May contain `[per dec-N]` references for decision provenance. */
  content: string;
}

export interface CreateStandardInput {
  title: string;
  /**
   * Ordered sections rendered by the UI / formatters. At least one section is required —
   * a standard with no rule content isn't a standard.
   */
  sections: StandardSectionInput[];
  /** Optional summary line surfaced in list views. Stored as the first section if provided. */
  description?: string;
}

export interface StandardWithSections extends Doc {
  sections: DocSection[];
  /** Live clauses across all sections (spec-150/161), ordered by allocate-once seq.
   * Group by `sectionId` for rendering; each carries its `cl-N` handle via `seq`. */
  clauses: StandardClause[];
  /** Drift markers — open `comment_type='drift'` comments scoped to this standard. */
  driftCount: number;
}

export interface StandardListEntry {
  id: string;
  handle: string;
  title: string;
  status: string;
  createdAt: Date;
  statusChangedAt: Date;
  sectionCount: number;
  /** Open drift-typed comments across all sections of this standard. */
  driftCount: number;
}

// ── Helpers ────────────────────────────────────────────

async function loadOwnedStandard(
  memexId: string,
  standardId: string,
): Promise<Doc> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, standardId), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Standard ${standardId} not found`);
  }
  if (doc.docType !== STANDARD_DOC_TYPE) {
    throw new ValidationError(
      `Document ${doc.handle} is a ${doc.docType}, not a standard. Use the generic doc tools for non-standard docs.`,
    );
  }
  return doc;
}

async function countOpenDriftCommentsForDocs(
  memexId: string,
  docIds: string[],
): Promise<Map<string, number>> {
  if (docIds.length === 0) return new Map();

  // Section / decision / work-item comments all carry account_id directly (t-1). For
  // standards we typically only see section-targeted drift comments, but join via the
  // section→doc edge to be future-proof if drift on decisions/work-items emerges.
  const rows = await db
    .select({
      docId: docSections.docId,
      count: sql<number>`count(${docComments.id})::int`,
    })
    .from(docComments)
    .innerJoin(docSections, eq(docComments.sectionId, docSections.id))
    .where(
      and(
        eq(docComments.memexId, memexId),
        eq(docComments.commentType, "drift"),
        sql`${docComments.resolvedAt} is null`,
        inArray(docSections.docId, docIds),
      ),
    )
    .groupBy(docSections.docId);

  const result = new Map<string, number>();
  for (const r of rows) {
    result.set(r.docId, Number(r.count));
  }
  return result;
}

// ── List + get ────────────────────────────────────────

export async function listStandards(
  memexId: string,
): Promise<StandardListEntry[]> {
  const rows = await db
    .select({
      id: documents.id,
      handle: documents.handle,
      title: documents.title,
      status: documents.status,
      createdAt: documents.createdAt,
      statusChangedAt: documents.statusChangedAt,
      sectionCount: sql<number>`count(${docSections.id})::int`,
    })
    .from(documents)
    .leftJoin(docSections, eq(documents.id, docSections.docId))
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, STANDARD_DOC_TYPE),
        sql`${documents.archivedAt} is null`,
      ),
    )
    .groupBy(documents.id)
    .orderBy(documents.createdAt);

  const driftCounts = await countOpenDriftCommentsForDocs(
    memexId,
    rows.map((r) => r.id),
  );

  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    title: r.title,
    status: r.status,
    createdAt: r.createdAt,
    statusChangedAt: r.statusChangedAt,
    sectionCount: Number(r.sectionCount),
    driftCount: driftCounts.get(r.id) ?? 0,
  }));
}

export async function getStandard(
  memexId: string,
  standardId: string,
): Promise<StandardWithSections> {
  const doc = await loadOwnedStandard(memexId, standardId);
  const sections = await db
    .select()
    .from(docSections)
    .where(eq(docSections.docId, doc.id))
    .orderBy(docSections.seq);

  const clauses = await db
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.docId, doc.id), ne(standardClauses.status, "deleted")))
    .orderBy(asc(standardClauses.seq));

  const driftCounts = await countOpenDriftCommentsForDocs(memexId, [doc.id]);
  return {
    ...doc,
    sections,
    clauses,
    driftCount: driftCounts.get(doc.id) ?? 0,
  };
}

// ── Create ────────────────────────────────────────────

export async function createStandard(
  memexId: string,
  input: CreateStandardInput,
  createdByUserId?: string,
): Promise<Mutated<StandardWithSections>> {
  const title = (input.title ?? "").trim();
  if (title.length === 0) {
    throw new ValidationError("Standard title must be a non-empty string");
  }

  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    throw new ValidationError(
      "Standard must have at least one section. Provide sections[] with sectionType + content.",
    );
  }

  // Build the row plan up front so we can validate before opening a transaction.
  const seenSectionTypes = new Set<string>();
  const sectionRows = input.sections.map((s, idx) => {
    const sectionType = (s.sectionType ?? "").trim();
    if (sectionType.length === 0) {
      throw new ValidationError(`sections[${idx}].sectionType must be a non-empty string`);
    }
    if (seenSectionTypes.has(sectionType)) {
      // doc_sections has a (doc_id, section_type) unique constraint — fail loudly here so
      // the caller sees a clean validation error rather than a Postgres dup-key error.
      throw new ValidationError(
        `Duplicate sectionType '${sectionType}' in standard sections. Each sectionType must be unique within a document.`,
      );
    }
    seenSectionTypes.add(sectionType);
    if (typeof s.content !== "string") {
      throw new ValidationError(`sections[${idx}].content must be a string`);
    }
    const sectionTitle =
      s.title?.trim() && s.title.trim().length > 0
        ? s.title.trim()
        : sectionType.charAt(0).toUpperCase() + sectionType.slice(1);
    return { sectionType, title: sectionTitle, content: s.content };
  });

  return mutate(
    {},
    (created) => ({ memexId, docId: created.id, entity: "document", action: "created" }),
    async () => {
      // spec-187: the std-N handle mint is the racy MAX+1 read — concurrent
      // standard creates in the same memex can collide on
      // `documents_memex_id_handle_unique`. Pure-DB tx → retry it wholesale.
      const result = await withSeqRetry(() => db.transaction(async (tx) => {
    const handle = await nextStandardHandle(memexId, tx);
    const [doc] = await tx
      .insert(documents)
      .values({
        memexId,
        handle,
        title,
        docType: STANDARD_DOC_TYPE,
        status: "draft",
        createdByUserId: createdByUserId ?? null,
      })
      .returning();

    // Optional `description` is rendered as a leading 'description' section so it is
    // editable through the same pipeline as any other standard content.
    const allRows: typeof sectionRows = [];
    if (input.description && input.description.trim().length > 0) {
      // If the caller already supplied a 'description' sectionType, don't double-insert.
      if (!seenSectionTypes.has("description")) {
        allRows.push({
          sectionType: "description",
          title: "Description",
          content: input.description.trim(),
        });
      }
    }
    allRows.push(...sectionRows);

    const sections = await tx
      .insert(docSections)
      .values(
        allRows.map((row, idx) => ({
          docId: doc.id,
          sectionType: row.sectionType,
          title: row.title,
          content: row.content,
          seq: idx + 1,
          position: idx + 1, // spec-150: display position == identity seq at creation
        })),
      )
      .returning();

    return { doc, sections };
  }), "documents_memex_id_handle_unique");

      // Fire-and-forget: embed every section in one provider batch. Failure is logged
      // inside the helper and does not surface to the caller — the standard is already
      // committed and the backfill script can replay missing rows.
      void embedAndStoreDoc(result.doc.id, { memexId }).catch(() => {
        // already logged inside the helper
      });

      return {
        ...result.doc,
        sections: result.sections,
        clauses: [],
        driftCount: 0,
      };
    },
  );
}

// ── Update by instruction ────────────────────────────

export interface UpdateStandardByInstructionResult {
  standard: Doc;
  /** The discussion comment recording the instruction (audit trail). */
  instructionComment: DocComment;
}

/**
 * Record an agent-driven update *instruction* against a standard. Per dec-14 / Section 6
 * of doc-10, the receiving side is agentic — the actual prose edits flow through the
 * agent's existing edit pipeline (calling `update_section`). What this helper captures
 * is the audit trail: a discussion comment on the first section of the standard
 * (sourced 'agent' when the agent calls it via MCP) explaining what change was requested
 * and why. The agent's content edits are subsequent calls to `update_section`.
 *
 * Why a comment, not a status / metadata column: dec-3 prohibits standard-specific
 * satellite tables; dec-18 says drift / staleness flags reuse `doc_comments`. Capturing
 * the instruction the same way keeps everything in the document substrate.
 */
export async function updateStandardByInstruction(
  memexId: string,
  standardId: string,
  instruction: string,
  authorName: string = "Memex agent",
): Promise<Mutated<UpdateStandardByInstructionResult>> {
  const trimmed = (instruction ?? "").trim();
  if (trimmed.length === 0) {
    throw new ValidationError("instruction must be a non-empty string");
  }

  const standard = await loadOwnedStandard(memexId, standardId);

  // First section — usually 'description' or 'overview'. Standards always have at least
  // one section (createStandard enforces it).
  const [firstSection] = await db
    .select()
    .from(docSections)
    .where(eq(docSections.docId, standard.id))
    .orderBy(docSections.seq)
    .limit(1);

  if (!firstSection) {
    // Shouldn't happen — defensive for standards created outside this service.
    throw new ValidationError(
      `Standard ${standard.handle} has no sections to anchor the instruction comment.`,
    );
  }

  return mutate(
    {},
    { memexId, docId: standard.id, entity: "document", action: "updated" },
    async () => {
      const instructionComment = await addComment(
        memexId,
        firstSection.id,
        authorName,
        `Update instruction:\n\n${trimmed}`,
        {
          type: "plan_revision",
          // Source is server-stamped — callers don't pass it. The MCP boundary always
          // resolves source='agent'; non-MCP callers (REST, etc.) get the schema default
          // ('human') which is fine for direct human-issued instructions.
          source: "agent",
        },
      );

      return { standard, instructionComment };
    },
  );
}

// ── propose_standard_change (t-8) ─────────────────────
// Agent-authored proposal to update a specific standard section. Lands as a typed
// `plan_revision` comment whose body is structured so the React UI's review/accept
// surface (t-12) can extract the proposed replacement text and render a diff.
//
// Body shape (stable contract — t-12 parses this):
//
//   **Proposed change to section [<sectionType>]**
//
//   <rationale or "(no rationale provided)">
//
//   ~~~proposed-content
//   <proposed full section text>
//   ~~~
//
// The ~~~ fence (not ```) is intentional: proposed content frequently contains
// triple-backtick code blocks, which would prematurely terminate a ``` fence.
// ~~~ is far less common in markdown source and keeps the parser unambiguous.
// Keep the fence + language tag stable; the t-12 UI looks for them specifically.

const PROPOSED_CONTENT_FENCE_OPEN = "~~~proposed-content";
const PROPOSED_CONTENT_FENCE_CLOSE = "~~~";

export interface ProposeStandardChangeResult {
  /** The standard the section belongs to. */
  standard: Doc;
  /** The section that was targeted. */
  section: DocSection;
  /** The plan_revision comment that holds the proposal. */
  comment: DocComment;
}

/**
 * Build the structured comment body for a proposed standard change. Exported for
 * t-12's UI parser to round-trip against, plus for tests that want to assert the
 * exact contract.
 */
export function buildProposedChangeBody(
  sectionType: string,
  proposed: string,
  rationale?: string,
): string {
  const rat = rationale?.trim() && rationale.trim().length > 0
    ? rationale.trim()
    : "(no rationale provided)";
  return [
    `**Proposed change to section [${sectionType}]**`,
    "",
    rat,
    "",
    PROPOSED_CONTENT_FENCE_OPEN,
    proposed,
    PROPOSED_CONTENT_FENCE_CLOSE,
  ].join("\n");
}

/**
 * Parser companion for buildProposedChangeBody — pull the proposed-content payload
 * out of a comment body. Returns null if the comment isn't shaped like a proposal.
 * Exported for the React UI / future server-side accept flow.
 */
export function parseProposedChangeBody(
  body: string,
): { proposed: string } | null {
  const start = body.indexOf(PROPOSED_CONTENT_FENCE_OPEN);
  if (start === -1) return null;
  const after = body.slice(start + PROPOSED_CONTENT_FENCE_OPEN.length);
  const end = after.indexOf(PROPOSED_CONTENT_FENCE_CLOSE);
  if (end === -1) return null;
  // Strip the leading newline that always follows the open fence + the trailing
  // newline before the close fence.
  const proposed = after.slice(0, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return { proposed };
}

export async function proposeStandardChange(
  memexId: string,
  standardSectionId: string,
  proposedContent: string,
  rationale?: string,
  options: { authorName?: string } = {},
  ctx: RequestCtx = {},
): Promise<Mutated<ProposeStandardChangeResult>> {
  if (typeof proposedContent !== "string" || proposedContent.trim().length === 0) {
    throw new ValidationError("proposedContent must be a non-empty string");
  }

  const section = await db.query.docSections.findFirst({
    where: eq(docSections.id, standardSectionId),
  });
  if (!section) {
    throw new NotFoundError(`Section ${standardSectionId} not found`);
  }

  // Account-scope + standard-type check.
  const standard = await loadOwnedStandard(memexId, section.docId);

  const body = buildProposedChangeBody(section.sectionType, proposedContent, rationale);

  // Two emits per dec-2 (spec-143) — mirrors flagDrift's dual emit:
  //  - comment.created fires from inside addComment for any tab subscribed to the standard doc.
  //  - standard_drift.created fires here for the StandardList aggregate drift-count subscriber,
  //    so the drift-count chip refetches when a plan-revision proposal lands (spec-156 ac-17).
  return mutate(
    ctx,
    { memexId, docId: section.docId, entity: "standard_drift", action: "created" },
    async () => {
      const comment = await addComment(
        memexId,
        standardSectionId,
        options.authorName ?? "Memex agent",
        body,
        {
          type: "plan_revision",
          // Source server-stamped per t-4 contract.
          source: "agent",
        },
      );

      return { standard, section, comment };
    },
  );
}

// ── Drift flag ────────────────────────────────────────

/**
 * Post a drift comment on a section of a standard. `source` is server-stamped:
 * agent-mediated callers (MCP) always pass 'agent'; bare service-layer calls default to
 * 'agent' too because drift detection is conceptually an agent activity. Per the t-4
 * contract this fn does NOT accept a caller-supplied source — that prevents spoofing.
 */
export async function flagDrift(
  memexId: string,
  standardSectionId: string,
  observation: string,
  options: { authorName?: string } = {},
  ctx: RequestCtx = {},
): Promise<Mutated<DocComment>> {
  const trimmed = (observation ?? "").trim();
  if (trimmed.length === 0) {
    throw new ValidationError("observation must be a non-empty string");
  }

  // Verify the section belongs to a standard document in this account.
  const section = await db.query.docSections.findFirst({
    where: eq(docSections.id, standardSectionId),
  });
  if (!section) {
    throw new NotFoundError(`Section ${standardSectionId} not found`);
  }

  // Account-scope check, plus standard-type check — both via loadOwnedStandard.
  await loadOwnedStandard(memexId, section.docId);

  // Two emits per dec-2 (doc-16) — independent invariants:
  //  - comment.created fires from inside addComment for any tab subscribed to the standard doc.
  //  - standard_drift.created fires here for the StandardList aggregate drift-count subscriber.
  return mutate(
    ctx,
    { memexId, docId: section.docId, entity: "standard_drift", action: "created" },
    async () =>
      addComment(
        memexId,
        standardSectionId,
        options.authorName ?? "Memex agent",
        trimmed,
        { type: "drift", source: "agent" },
      ),
  );
}

// ── Decision-affected lookup (FTS) ─────────────────────

export interface AffectedStandardMatch {
  standard: Doc;
  /** Sections that mention `[per dec-N]`. */
  matchingSections: DocSection[];
}

/**
 * Find every standard in the account whose section content references a given decision
 * via the conventional `[per dec-N]` inline citation (Section 6 of doc-10, dec-17).
 *
 * Lookup mechanism: Postgres FTS over the materialised `doc_sections.content_tsv`
 * generated column (added in 0027_v2_deferral_fixes via t-20 W-D). The
 * `doc_sections_content_tsv_idx` GIN index turns the FTS narrow from a sequential scan
 * into a bitmap index scan, which matters once standard volume grows past trivial.
 * A literal ILIKE post-filter confirms the `[per dec-N]` shape so we don't
 * false-positive on any section that happens to contain the words `dec` and `N`
 * separately.
 *
 * Idempotency / dedup: returns deterministic `Doc` rows; callers (t-13) decide how to
 * handle re-runs — typically by checking for an existing drift comment with the same
 * decision handle in its content.
 */
export async function findStandardsAffectedByDecision(
  memexId: string,
  decisionHandle: string,
): Promise<AffectedStandardMatch[]> {
  // Accept "dec-7", "DEC-7", and the bare "7" form just in case. Normalise to "dec-N".
  const handle = decisionHandle.trim().toLowerCase();
  const match = handle.match(/^(?:dec-)?(\d+)$/);
  if (!match) {
    throw new ValidationError(
      `Invalid decision handle '${decisionHandle}'. Expected format: 'dec-N' (e.g. 'dec-7').`,
    );
  }
  const seqNum = match[1];
  const normalisedHandle = `dec-${seqNum}`;

  // FTS-narrow: pass `dec-N` with the hyphen so plainto_tsquery tokenises it as
  // 'dec' & '-N' under the english config. That matches how the section body's
  // `[per dec-7]` reference also tokenises (the parser keeps the leading hyphen on the
  // numeric portion as the lexeme `'-7'`). Stripping the hyphen and passing
  // `dec ${seqNum}` would produce `'dec' & '7'` which DOES NOT MATCH the body's `'-7'`
  // lexeme — so the FTS narrow would silently drop every legitimate match.
  const ftsQuery = normalisedHandle;
  // Literal pattern: the post-filter that excludes false positives. ILIKE is case-insensitive
  // and exact on the bracketed form.
  const literalPattern = `%[per ${normalisedHandle}]%`;

  const rows = await db
    .select({
      docId: documents.id,
      docHandle: documents.handle,
      docTitle: documents.title,
      docDocType: documents.docType,
      docStatus: documents.status,
      docAccountId: documents.memexId,
      docParentDocId: documents.parentDocId,
      docCreatedAt: documents.createdAt,
      docStatusChangedAt: documents.statusChangedAt,
      docArchivedAt: documents.archivedAt,
      docPausedAt: documents.pausedAt,
      docNarrativeLastConsolidatedAt: documents.narrativeLastConsolidatedAt,
      sectionId: docSections.id,
      sectionDocId: docSections.docId,
      sectionType: docSections.sectionType,
      sectionTitle: docSections.title,
      sectionDescription: docSections.description,
      sectionContent: docSections.content,
      sectionPreamble: docSections.preamble,
      sectionSeq: docSections.seq,
      sectionPosition: docSections.position,
      sectionCreatedAt: docSections.createdAt,
      sectionUpdatedAt: docSections.updatedAt,
      sectionStatus: docSections.status,
      sectionPreviousStatus: docSections.previousStatus,
    })
    .from(docSections)
    .innerJoin(documents, eq(docSections.docId, documents.id))
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, STANDARD_DOC_TYPE),
        sql`${documents.archivedAt} is null`,
        // FTS pre-narrow against the materialised `content_tsv` generated column —
        // backed by the `doc_sections_content_tsv_idx` GIN index (t-20 W-D /
        // 0027_v2_deferral_fixes). Postgres rewrites the @@ to a bitmap index scan
        // so candidate sections are fetched without a sequential pass over the
        // table. The query string still passes through plainto_tsquery for the
        // 'dec-N' tokenisation alignment described above. The `content_tsv` column
        // is referenced via raw SQL because it isn't modelled in the Drizzle
        // schema (a generated column in InferSelectModel would force every
        // DocSection fixture to set it — see schema.ts comment).
        sql`doc_sections.content_tsv @@ plainto_tsquery('english', ${ftsQuery})`,
        // Literal post-filter (case-insensitive ILIKE for `[per dec-N]`)
        sql`${docSections.content} ilike ${literalPattern}`,
        // Exclude soft-deleted sections from drift matches (spec-107).
        sql`(${docSections.status} <> 'deleted' OR ${docSections.status} IS NULL)`,
      ),
    )
    .orderBy(documents.handle, docSections.seq);

  // Group rows by standard id.
  const byDoc = new Map<string, AffectedStandardMatch>();
  for (const row of rows) {
    let entry = byDoc.get(row.docId);
    if (!entry) {
      entry = {
        standard: {
          id: row.docId, memexId: row.docAccountId,
          handle: row.docHandle,
          title: row.docTitle,
          docType: row.docDocType,
          status: row.docStatus,
          parentDocId: row.docParentDocId,
          createdByUserId: null,
          createdAt: row.docCreatedAt,
          statusChangedAt: row.docStatusChangedAt,
          archivedAt: row.docArchivedAt,
          pausedAt: row.docPausedAt,
          narrativeLastConsolidatedAt: row.docNarrativeLastConsolidatedAt,
          isDemo: false,
        },
        matchingSections: [],
      };
      byDoc.set(row.docId, entry);
    }
    entry.matchingSections.push({
      id: row.sectionId,
      docId: row.sectionDocId,
      sectionType: row.sectionType,
      title: row.sectionTitle,
      description: row.sectionDescription,
      content: row.sectionContent,
      preamble: row.sectionPreamble,
      seq: row.sectionSeq,
      position: row.sectionPosition,
      createdAt: row.sectionCreatedAt,
      updatedAt: row.sectionUpdatedAt,
      status: row.sectionStatus,
      previousStatus: row.sectionPreviousStatus,
      // spec-122 activity contract — not selected by the standards-drift match
      // query (irrelevant to the affected-standards view), so null here.
      actorUserId: null,
      actorName: null,
      channel: null,
    });
  }
  return Array.from(byDoc.values());
}

/**
 * Resolve a decision UUID to its `dec-N` handle within an account. Convenience for the
 * MCP `affected_by_decision` tool, which takes a UUID rather than a handle.
 */
export async function getDecisionHandleById(
  memexId: string,
  decisionId: string,
): Promise<string> {
  const dec = await db.query.decisions.findFirst({
    where: and(eq(decisions.id, decisionId), eq(decisions.memexId, memexId)),
  });
  if (!dec) {
    throw new NotFoundError(`Decision ${decisionId} not found`);
  }
  return `dec-${dec.seq}`;
}

// ── Decision-triggered drift scan (t-13) ──────────────────────
// Per dec-28: when a decision flips to resolved, scan all standards in the same account
// for `[per dec-N]` references and post a typed `drift` comment on each affected section
// so standard owners know the rule may need review. This is the post-commit side-effect
// invoked from services/decisions.ts::resolveDecision.

const DEBUG_DRIFT_SCAN = process.env.DEBUG_AGENT !== "0";

/** Stable phrase used to detect previously-posted drift comments for the same decision. */
const DRIFT_COMMENT_RESOLVED_MARKER = "was resolved";

/**
 * Build the drift comment body for a resolved decision. The phrase
 * `Decision dec-N ("<title>") was resolved` includes the handle and the marker phrase
 * (`was resolved`) — both used for idempotency lookup. Title can be edited later, so
 * dedup checks must NOT match on title — only on handle + marker.
 */
function driftCommentBody(decisionHandle: string, decisionTitle: string): string {
  return `Decision ${decisionHandle} ("${decisionTitle}") was resolved; this rule may need review.`;
}

/**
 * Idempotency predicate: a section already has a drift comment for this decision iff
 * an OPEN drift comment exists whose content references the handle and contains the
 * `was resolved` marker. We deliberately don't match the full body — titles can be
 * edited between resolve and re-resolve, so a strict equality check would fail to
 * dedupe and we'd duplicate the comment.
 */
function alreadyFlagged(
  comment: DocComment,
  decisionHandle: string,
): boolean {
  if (comment.commentType !== "drift") return false;
  const content = comment.content ?? "";
  return (
    content.includes(decisionHandle) &&
    content.includes(DRIFT_COMMENT_RESOLVED_MARKER)
  );
}

/**
 * Post-commit drift scan run by `resolveDecision`. For every standard section in the
 * account that mentions `[per dec-N]`, post a `drift` typed comment unless one already
 * exists for the same decision (per `alreadyFlagged`).
 *
 * Returns the count of NEWLY-flagged standards (not sections) so the log line matches
 * the spec language "<count> standards flagged".
 *
 * **Best-effort.** Callers should wrap in try/catch — drift detection is not part of the
 * decision-resolution transaction and must not propagate failures (the decision is
 * already committed by the time this runs).
 */
// Called as side-effect from resolveDecision; no manual MCP trigger today. Tracked on doc-10 deferral list (item #5).
export async function scanForDecisionDrift(
  memexId: string,
  decisionHandle: string,
  decisionTitle: string,
): Promise<{ standardsFlagged: number; sectionsFlagged: number }> {
  const matches = await findStandardsAffectedByDecision(memexId, decisionHandle);

  if (matches.length === 0) {
    if (DEBUG_DRIFT_SCAN) {
      // eslint-disable-next-line no-console
      console.log(`[AGENT drift-scan] ${decisionHandle} → 0 (no references)`);
    }
    return { standardsFlagged: 0, sectionsFlagged: 0 };
  }

  const body = driftCommentBody(decisionHandle, decisionTitle);

  let standardsFlagged = 0;
  let sectionsFlagged = 0;

  for (const match of matches) {
    let flaggedAnySectionInThisStandard = false;

    for (const section of match.matchingSections) {
      // Account-scoped check on existing drift comments for this section.
      const existing = await db.query.docComments.findMany({
        where: and(
          eq(docComments.sectionId, section.id),
          eq(docComments.memexId, memexId),
        ),
      });
      const dup = existing.some((c) => alreadyFlagged(c, decisionHandle));
      if (dup) continue;

      // flagDrift handles validation + emits a doc-events `comment created` event so SSE
      // subscribers refresh. Source is server-stamped to 'agent' inside the helper.
      await flagDrift(memexId, section.id, body);
      sectionsFlagged += 1;
      flaggedAnySectionInThisStandard = true;
    }

    if (flaggedAnySectionInThisStandard) {
      standardsFlagged += 1;
    }
  }

  if (DEBUG_DRIFT_SCAN) {
    // eslint-disable-next-line no-console
    console.log(
      `[AGENT drift-scan] ${decisionHandle} → ${standardsFlagged} standard${
        standardsFlagged === 1 ? "" : "s"
      } flagged (${sectionsFlagged} section${sectionsFlagged === 1 ? "" : "s"})`,
    );
  }

  return { standardsFlagged, sectionsFlagged };
}

// ── Ambiguous bare decision-reference scan (t-20 W-A) ─────────────────────
// One-time helper. Walks every standard section in the account, extracts bare
// `[per dec-N]` references (the legacy form), and posts a typed `drift` comment
// on the section for each reference whose bare handle matches MORE THAN ONE
// decision in the account. Qualified `[per doc-N:dec-M]` references are
// skipped — they're already unambiguous.
//
// Does NOT auto-rewrite standard content (per the t-20 hard constraints):
// the human reviewer reads the drift comment and decides which decision the
// reference should bind to before editing the source.
//
// Idempotent: dedupes against existing drift comments on the same section that
// mention the same handle and the marker phrase "ambiguous reference" — re-runs
// don't multiply comments. Returns the count of NEWLY-flagged sections so a
// caller (CLI / one-shot script / admin tool) can report progress.

const AMBIGUOUS_REF_MARKER = "ambiguous reference";

function ambiguousRefAlreadyFlagged(comment: DocComment, handle: string): boolean {
  if (comment.commentType !== "drift") return false;
  const content = comment.content ?? "";
  return content.includes(handle) && content.includes(AMBIGUOUS_REF_MARKER);
}

function ambiguousRefBody(handle: string, candidates: string[]): string {
  // Body uses the AMBIGUOUS_REF_MARKER substring so the dedup predicate above
  // can spot a previously-posted comment without exact-match string compare.
  return [
    `Bare reference \`[per ${handle}]\` is an ambiguous reference: it matches ${candidates.length} decisions in this account.`,
    "",
    "Candidates:",
    ...candidates.map((c) => `- \`${c}\``),
    "",
    `Rewrite as \`[per <one-of-the-candidates>]\` to disambiguate.`,
  ].join("\n");
}

export interface AmbiguousReferenceScanResult {
  standardsScanned: number;
  sectionsScanned: number;
  ambiguousReferencesFound: number;
  newDriftCommentsPosted: number;
}

export async function scanForAmbiguousBareDecisionReferences(
  memexId: string,
): Promise<AmbiguousReferenceScanResult> {
  // Pull every standard + sections in this account.
  const sections = await db
    .select({
      sectionId: docSections.id,
      docId: docSections.docId,
      content: docSections.content,
    })
    .from(docSections)
    .innerJoin(documents, eq(docSections.docId, documents.id))
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, STANDARD_DOC_TYPE),
        sql`${documents.archivedAt} is null`,
      ),
    );

  // Bare-only matcher — qualified references (`[per doc-N:dec-M]`) skip this
  // scan because they're already disambiguated.
  const BARE_REF_REGEX = /\[per (dec-\d+)\](?!:)/g;

  // Per-account bare-handle multiplicity map: dec-N → list of qualified candidates.
  // Built lazily and memoised inside the loop.
  const candidatesCache = new Map<string, string[]>();

  let ambiguousReferencesFound = 0;
  let newDriftCommentsPosted = 0;
  const standardsTouched = new Set<string>();

  for (const section of sections) {
    BARE_REF_REGEX.lastIndex = 0;
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = BARE_REF_REGEX.exec(section.content)) !== null) {
      const handle = match[1]; // 'dec-7'
      if (seen.has(handle)) continue; // one drift comment per (section, handle)
      seen.add(handle);

      let candidates = candidatesCache.get(handle);
      if (!candidates) {
        const decSeq = Number(handle.slice("dec-".length));
        const rows = await db
          .select({
            seq: decisions.seq,
            docHandle: documents.handle,
          })
          .from(decisions)
          .innerJoin(documents, eq(decisions.docId, documents.id))
          .where(and(eq(decisions.memexId, memexId), eq(decisions.seq, decSeq)));
        candidates = rows
          .map((r) => `${r.docHandle}:dec-${r.seq}`)
          .sort();
        candidatesCache.set(handle, candidates);
      }
      if (candidates.length <= 1) continue; // unambiguous — skip

      ambiguousReferencesFound += 1;

      const existing = await db.query.docComments.findMany({
        where: and(
          eq(docComments.sectionId, section.sectionId),
          eq(docComments.memexId, memexId),
        ),
      });
      if (existing.some((c) => ambiguousRefAlreadyFlagged(c, handle))) continue;

      await flagDrift(memexId, section.sectionId, ambiguousRefBody(handle, candidates));
      newDriftCommentsPosted += 1;
      standardsTouched.add(section.docId);
    }
  }

  return {
    standardsScanned: new Set(sections.map((s) => s.docId)).size,
    sectionsScanned: sections.length,
    ambiguousReferencesFound,
    newDriftCommentsPosted,
  };
}
