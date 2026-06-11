import { eq, asc, and, isNull, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { decisions, documents, docComments } from "../db/schema.js";
import type { Decision } from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { resolveActorColumns } from "./actor.js";
import { nextSeq, withSeqRetry } from "./shared/sequence.js";
import { isUuid, parseHandle } from "./shared/identifiers.js";
import { embedAndStoreDecision } from "./memex-embeddings.js";

// Fire-and-forget embed for a decision whose searchable text just changed.
// Mirrors maybeEmbedSectionInBackground in services/sections.ts (b-34 T-2).
// We pass memexId for defence-in-depth — the helper filters its lookup by
// memex_id so a stray caller can't re-embed a stranger's decision by UUID.
// We swallow rejections — embedding failure must never surface as a failed
// decision write (best-effort contract per b-34 D-2).
function maybeEmbedDecisionInBackground(memexId: string, decisionId: string): void {
  void embedAndStoreDecision(decisionId, { memexId }).catch(() => {
    // already logged inside the helper; nothing more to do.
  });
}

// Per t-20 W-A: bare `dec-N` handles can collide within an account because the
// `decisions.seq` sequence is per-doc, not per-account. When a caller uses a
// bare handle that matches multiple rows we throw this — the REST route renders
// it as a 409 with the qualified-handle candidates so the caller can pick one.
export class AmbiguousDecisionHandleError extends ConflictError {
  readonly candidates: string[];
  constructor(handle: string, candidates: string[]) {
    super(
      `Decision handle ${handle} is ambiguous; ${candidates.length} matches in this account.`,
      "AMBIGUOUS_DECISION_HANDLE",
    );
    this.candidates = candidates;
  }
}

// Per t-7 / dec-2: `mis-N:dec-M` is the canonical Spec decision cite — but
// the `mis-N` prefix only resolves correctly when the underlying document
// is actually a Spec. When a caller uses a `mis-` prefix against a
// non-Spec parent (e.g. a Standard), the REST route renders this as a 409
// so the caller can rewrite the cite. Carries the actual docType for clarity.
export class SpecParentMismatchError extends ConflictError {
  readonly docHandle: string;
  readonly actualDocType: string;
  constructor(docHandle: string, actualDocType: string) {
    // Strip whichever prefix (`spec-` post b-105, `doc-` for legacy data still on
    // `doc-N`) to recover the bare N for the error message.
    const n = docHandle.replace(/^(spec|doc)-/i, "");
    super(
      `\`mis-${n}\` cite must reference a Spec; ${docHandle} is a ${actualDocType}`,
      "SPEC_PARENT_MISMATCH",
    );
    this.docHandle = docHandle;
    this.actualDocType = actualDocType;
  }
}

// Per b-105: docType='spec' is the canonical Spec container. (The lineage
// — strategy → mission → brief → spec — is preserved in migration SQL only.)
// Centralised here so the `mis-N` cite resolver and any future Spec-gating
// logic agree on what counts.
function isSpecDocType(docType: string): boolean {
  return docType === "spec";
}

// Per dec-8 (and Section 3 of doc-10): structured options on a decision are stored as
// JSONB `Array<{ label, trade_offs }>`. The column itself is unconstrained (jsonb), so
// shape is enforced here in the service layer. Snake-case `trade_offs` matches the
// agreed wire format from dec-8 — don't camelCase it.
export interface DecisionOption {
  label: string;
  trade_offs: string;
}

// Verifies the doc exists in the account; throws NotFoundError otherwise. Used to gate
// child mutations (decisions, tasks, comments) that flow through a parent doc.
async function assertDocInAccount(memexId: string, docId: string): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  if (!doc) throw new NotFoundError(`Document ${docId} not found`);
}

function validateOptions(value: unknown): DecisionOption[] {
  if (!Array.isArray(value)) {
    throw new ValidationError("options must be an array of { label, trade_offs }");
  }
  return value.map((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      throw new ValidationError(`options[${idx}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.label !== "string" || obj.label.trim().length === 0) {
      throw new ValidationError(`options[${idx}].label must be a non-empty string`);
    }
    if (typeof obj.trade_offs !== "string") {
      throw new ValidationError(`options[${idx}].trade_offs must be a string`);
    }
    return { label: obj.label, trade_offs: obj.trade_offs };
  });
}

function validateChosenIndex(
  options: DecisionOption[] | null,
  index: number,
): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new ValidationError("chosenOptionIndex must be a non-negative integer");
  }
  if (!options || options.length === 0) {
    throw new ValidationError(
      "chosenOptionIndex requires options to be set on the decision first",
    );
  }
  if (index >= options.length) {
    throw new ValidationError(
      `chosenOptionIndex ${index} is out of bounds (options length ${options.length})`,
    );
  }
}

export async function createDecision(
  memexId: string,
  docId: string,
  title: string,
  context?: string,
  source: "human" | "agent" = "human",
  ctx: RequestCtx = {},
): Promise<Mutated<Decision>> {
  await assertDocInAccount(memexId, docId);
  // createDecision is the direct (REST + create_decision MCP) path. Default 'human'
  // since the typical caller is the human authoring tool; agent-driven creation
  // flows through proposeDecision which sets 'agent' explicitly.
  // b-38 F-3 — wrap allocator + insert in withSeqRetry so concurrent createDecision
  // calls under the same doc don't 23505 on `decisions_doc_id_seq_unique`.
  const result = await mutate(
    ctx,
    { memexId, docId, entity: "decision", action: "created" },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(decisions, decisions.seq, decisions.docId, docId);
          const [decision] = await db
            .insert(decisions)
            // spec-122 dec-2/dec-5 — stamp WHO + HOW at write time (ac-20).
            .values({ memexId, docId, seq, title, context: context ?? null, status: "open", source, ...(await resolveActorColumns(ctx)) })
            .returning();
          return decision;
        },
        "decisions_doc_id_seq_unique",
      ),
  );
  maybeEmbedDecisionInBackground(memexId, result.id);
  return result;
}

// b-97 t-3: `includeDeleted` defaults to false so every legacy caller automatically
// suppresses soft-deleted rows. Pass `true` from the Deleted-tab path (or any
// audit/recovery surface) to get them back in the result set.
export async function listDecisions(
  memexId: string,
  docId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<Decision[]> {
  const baseConditions = [eq(decisions.docId, docId), eq(decisions.memexId, memexId)];
  if (!opts.includeDeleted) {
    baseConditions.push(ne(decisions.status, "deleted"));
  }
  return db
    .select()
    .from(decisions)
    .where(and(...baseConditions))
    .orderBy(asc(decisions.seq));
}

export async function getDecision(
  memexId: string,
  idOrHandle: string,
  docId?: string,
): Promise<Decision> {
  const seqNum = parseHandle(idOrHandle, "D-");
  let decision: Decision | undefined;

  if (seqNum !== null && docId) {
    decision = await db.query.decisions.findFirst({
      where: (d, { and, eq: e }) =>
        and(e(d.docId, docId), e(d.seq, seqNum), e(d.memexId, memexId)),
    });
  } else if (isUuid(idOrHandle)) {
    decision = await db.query.decisions.findFirst({
      where: and(eq(decisions.id, idOrHandle), eq(decisions.memexId, memexId)),
    });
  } else {
    throw new ValidationError(
      `Invalid decision identifier: ${idOrHandle}. Use a UUID or dec-N format with a docId.`,
    );
  }

  if (!decision) {
    throw new NotFoundError(`Decision ${idOrHandle} not found`);
  }
  return decision;
}

/**
 * Parse a canonical decision handle into its component parts. Three forms accepted
 * (per t-7 / dec-2):
 *
 *  - **`mis-N:dec-M`** — Canonical Spec cite. The parser surfaces the
 *    parent's identity via `parentKind: 'spec'`; the resolver then asserts
 *    the parent doc actually has `docType='spec'` and returns 409
 *    otherwise. Per b-105, specs live at `spec-N`, so the `mis-`
 *    prefix in the cite text rewrites to `spec-N` for lookup. The `mis-` cite
 *    syntax is kept for back-compat with stored standards content.
 *  - **`spec-N:dec-M`** — NEW canonical Spec cite (typed handle form, b-105).
 *  - **`doc-N:dec-M`** — LEGACY qualified form (t-20 W-A). Parses forever for
 *    back-compat with existing standard content; resolves against free-form
 *    documents (which still use `doc-N`) and any pre-migration spec content.
 *  - **`dec-N`**       — LEGACY bare form. Resolves to a unique decision when
 *    the bare handle is unambiguous in the account, 409s otherwise.
 *
 * Returns `null` for any malformed input — caller should treat that as a
 * ValidationError.
 */
export function parseDecisionHandle(
  raw: string,
): {
  docHandle: string | null;
  decSeq: number;
  parentKind: "spec" | "any" | null;
} | null {
  if (typeof raw !== "string") return null;
  // The seq sequence on `decisions` is per-doc. With qualified handles we can
  // narrow by docHandle first; bare lookups search the account.
  // Spec-qualified form: `mis-N:(D|dec)-M`. The parser rewrites `mis-N` to
  // the underlying `spec-N` handle (per b-105, specs live at `spec-N`; the
  // `mis-` cite syntax stays as the canonical Spec cite form in standards
  // content per dec-2) and tags `parentKind='spec'` so the resolver knows to
  // enforce docType. Both `D-M` (canonical) and `dec-M` (legacy, still
  // emitted by un-migrated standard content) accepted.
  const specQualified = raw.match(/^mis-(\d+):(?:D|dec)-(\d+)$/i);
  if (specQualified) {
    return {
      docHandle: `spec-${specQualified[1]}`,
      decSeq: Number(specQualified[2]),
      parentKind: "spec",
    };
  }
  // Qualified form: `<docHandle>:(D|dec)-<M>` where docHandle is `spec-N`
  // (Specs, b-105), `doc-N` (free-form documents and execution-plans, plus
  // legacy spec content pre-b-105) or `std-N` (Standards, per dec-7 of
  // doc-8). All share the `documents.handle` column — the prefix just
  // distinguishes docType-typed handles. Decision portion accepts both
  // `D-M` (canonical) and `dec-M` (legacy fallback for standards content).
  // /i means uppercase variants (`SPEC-3:D-7`) also parse to the same shape.
  const qualified = raw.match(/^((?:spec|doc|std)-\d+):(?:D|dec)-(\d+)$/i);
  if (qualified) {
    return { docHandle: qualified[1], decSeq: Number(qualified[2]), parentKind: "any" };
  }
  // Bare form accepts both `D-N` (canonical) and `dec-N` (legacy fallback).
  const bare = raw.match(/^(?:D|dec)-(\d+)$/i);
  if (bare) {
    return { docHandle: null, decSeq: Number(bare[1]), parentKind: null };
  }
  return null;
}

/**
 * Format a decision plus its parent doc handle as the qualified canonical handle
 * `<parentHandle>:D-M` (post doc-26 rename — `doc-N:D-M` for Specs and generic
 * documents, `std-N:D-M` for Standards). Use everywhere a decision is exposed
 * cross-document (MCP output, standard references, agent prose). Matches the
 * format emitted by `mcp/formatters.ts` so callers see one canonical shape.
 */
export function qualifiedDecisionHandle(
  parentDocHandle: string,
  decisionSeq: number,
): string {
  return `${parentDocHandle}:D-${decisionSeq}`;
}

/**
 * Lookup by qualified `doc-N:dec-M` form. Account-scoped through the docHandle
 * narrow; cannot be ambiguous (the (docId, seq) unique constraint on `decisions`
 * guarantees at most one match).
 *
 * When `requireSpecParent: true` (set by the `mis-N:dec-M` cite parser per
 * t-7 / dec-2), the parent doc must have docType='spec' — otherwise this throws
 * `SpecParentMismatchError` (rendered as 409). The DB `handle` column is
 * generic per dec-2; the parent-kind constraint is the semantic narrowing
 * layered on top of `mis-N` cites.
 *
 * Throws NotFoundError on miss; ValidationError on a malformed handle;
 * SpecParentMismatchError when a `mis-` cite resolves to a non-Spec.
 */
export async function getDecisionByQualifiedHandle(
  memexId: string,
  docHandle: string,
  decHandle: string,
  options: { requireSpecParent?: boolean } = {},
): Promise<Decision> {
  // Accept both `D-N` (canonical post doc-26) and `dec-N` (legacy fallback,
  // still emitted by un-migrated standards content) — the same dual-form
  // tolerance applied by `parseDecisionHandle`. Internal callers synthesize
  // `dec-${seq}` today; widening here keeps that path working without forcing
  // every call site to switch to the new prefix at once.
  const decSeq = parseHandle(decHandle, "D-") ?? parseHandle(decHandle, "dec-");
  if (decSeq === null) {
    throw new ValidationError(
      `Invalid decision handle: ${decHandle}. Expected D-N or dec-N format.`,
    );
  }
  const parent = await db.query.documents.findFirst({
    where: and(eq(documents.handle, docHandle), eq(documents.memexId, memexId)),
  });
  if (!parent) {
    throw new NotFoundError(`Document ${docHandle} not found`);
  }
  if (options.requireSpecParent && !isSpecDocType(parent.docType)) {
    throw new SpecParentMismatchError(docHandle, parent.docType);
  }
  const decision = await db.query.decisions.findFirst({
    where: and(
      eq(decisions.memexId, memexId),
      eq(decisions.docId, parent.id),
      eq(decisions.seq, decSeq),
    ),
  });
  if (!decision) {
    throw new NotFoundError(
      `Decision ${docHandle}:D-${decSeq} not found`,
    );
  }
  return decision;
}

/**
 * Resolve a decision handle to a Decision *across an entire account*, without
 * requiring the caller to know the parent docId. Used by t-18's standard
 * `[per dec-N]` reference rendering and by every other "I have a handle, give
 * me the row" call.
 *
 * Accepts THREE forms:
 *  - **Spec-qualified** (`mis-N:dec-M`): t-7 canonical. Resolves the parent
 *    via `doc-N` (per the revised doc-26 the DB handle stays generic) and
 *    asserts the parent's docType is a Spec. Returns 409
 *    `SpecParentMismatchError` when the parent isn't a Spec.
 *  - **Doc-qualified** (`doc-N:dec-M`): t-20 W-A legacy. Same lookup mechanism
 *    as the Spec form but accepts any docType — supports old standard
 *    content authored before t-7.
 *  - **Bare** (`dec-M`): t-18 legacy. The `decisions.seq` sequence is per-doc,
 *    so multiple Specs in the same account can independently produce a
 *    `dec-7`. When that happens, this fn throws `AmbiguousDecisionHandleError`
 *    with the candidate qualified handles — the route renders that as a 409
 *    so callers can disambiguate. There is NO silent first-match fallback
 *    (that was the bug t-18 surfaced).
 *
 * Throws:
 *  - `ValidationError` on a malformed handle (none of the three forms).
 *  - `NotFoundError` when no matching decision exists in the account.
 *  - `AmbiguousDecisionHandleError` (a ConflictError) when bare handle matches
 *     more than one decision; payload carries `candidates: string[]` of qualified
 *     handles to choose from.
 *  - `SpecParentMismatchError` (a ConflictError) when a `mis-N:dec-M` cite
 *     resolves to a non-Spec parent.
 */
export async function getDecisionByHandle(
  memexId: string,
  handle: string,
  parentDocId?: string,
): Promise<Decision> {
  const parsed = parseDecisionHandle(handle);
  if (parsed === null) {
    throw new ValidationError(
      `Invalid decision handle: ${handle}. Expected D-N, spec-N:D-M, doc-N:D-M, std-N:D-M, or mis-N:D-M format (legacy dec-N also accepted).`,
    );
  }

  // Qualified path — unambiguous lookup. `mis-` prefix layers a parent-kind
  // assertion on top of the same docHandle × decSeq narrow. `parentDocId` is
  // ignored here because the handle already encodes the parent doc.
  if (parsed.docHandle !== null) {
    return getDecisionByQualifiedHandle(
      memexId,
      parsed.docHandle,
      `dec-${parsed.decSeq}`,
      { requireSpecParent: parsed.parentKind === "spec" },
    );
  }

  // Bare path — search across the account, then disambiguate. b-42 t-2: when
  // `parentDocId` is provided, scope the search to that doc — handles are
  // unique within a doc so the result is unambiguous and the REST UI can
  // resolve bare `[per dec-N]` references in section / comment markdown
  // without 409ing on memexes that have multiple docs with dec-1.
  const conditions = [
    eq(decisions.memexId, memexId),
    eq(decisions.seq, parsed.decSeq),
  ];
  if (parentDocId !== undefined) {
    conditions.push(eq(decisions.docId, parentDocId));
  }
  const matches = await db
    .select({
      id: decisions.id,
      docId: decisions.docId,
      seq: decisions.seq,
      docHandle: documents.handle,
    })
    .from(decisions)
    .innerJoin(documents, eq(decisions.docId, documents.id))
    .where(and(...conditions));

  if (matches.length === 0) {
    throw new NotFoundError(`Decision ${handle} not found`);
  }

  if (matches.length > 1) {
    const candidates = matches
      .map((m) => qualifiedDecisionHandle(m.docHandle, m.seq))
      .sort();
    throw new AmbiguousDecisionHandleError(handle, candidates);
  }

  // Single match — return the full row.
  const decision = await db.query.decisions.findFirst({
    where: and(eq(decisions.id, matches[0].id), eq(decisions.memexId, memexId)),
  });
  if (!decision) {
    // Shouldn't happen — the row was just selected — but defensive.
    throw new NotFoundError(`Decision ${handle} not found`);
  }
  return decision;
}

// ── Multi-option / candidate workflow (t-5) ─────────────────
// Per dec-4 / dec-20 / dec-21 / dec-22: decisions can enter the table as candidates
// proposed by the agent (per-turn extraction), then a human reviewer approves them
// (→ open) or rejects them (→ rejected, kept as audit). Once open, resolveDecision
// applies the standard open→resolved transition; a chosenOptionIndex picks one of the
// stored options. Status transitions are strict — invalid jumps throw ValidationError.

export interface ProposeDecisionInput {
  title: string;
  context?: string | null;
  options?: DecisionOption[];
  /**
   * Provenance: 'agent' for per-turn extraction (dec-20), 'human' for human-driven
   * candidate creation. Persisted on `decisions.source` (added in 0027_v2_deferral_fixes).
   * Defaults to 'agent' because the only path that calls `proposeDecision` today is the
   * candidate workflow on the agent side; if no value is supplied, the column default
   * ('human') is overridden here.
   */
  source?: "agent" | "human";
}

export async function proposeDecision(
  memexId: string,
  docId: string,
  input: ProposeDecisionInput,
): Promise<Mutated<Decision>> {
  await assertDocInAccount(memexId, docId);
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new ValidationError("title must be a non-empty string");
  }

  const validatedOptions = input.options !== undefined ? validateOptions(input.options) : null;

  // Source defaults to 'agent' for proposeDecision callers: per-turn extraction
  // (dec-20) and the MCP propose_decision tool both default to agent; the human
  // candidate-review path can override explicitly. The DB column default is 'human'
  // — a deliberate write here makes the provenance explicit on every candidate row.
  const source: "agent" | "human" = input.source ?? "agent";
  // b-38 F-3 — wrap allocator + insert in withSeqRetry so concurrent proposeDecision
  // calls under the same doc don't 23505 on `decisions_doc_id_seq_unique`.
  const result = await mutate(
    {},
    { memexId, docId, entity: "decision", action: "created" },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(decisions, decisions.seq, decisions.docId, docId);
          const [decision] = await db
            .insert(decisions)
            .values({
              memexId,
              docId,
              seq,
              title: input.title.trim(),
              context: input.context ?? null,
              status: "candidate",
              options: validatedOptions,
              source,
            })
            .returning();
          return decision;
        },
        "decisions_doc_id_seq_unique",
      ),
  );
  maybeEmbedDecisionInBackground(memexId, result.id);
  return result;
}

async function loadOwnedDecision(memexId: string, id: string): Promise<Decision> {
  const decision = await db.query.decisions.findFirst({
    where: and(eq(decisions.id, id), eq(decisions.memexId, memexId)),
  });
  if (!decision) {
    throw new NotFoundError(`Decision ${id} not found`);
  }
  return decision;
}

export async function approveDecision(memexId: string, id: string): Promise<Mutated<Decision>> {
  const decision = await loadOwnedDecision(memexId, id);
  if (decision.status !== "candidate") {
    throw new ValidationError(
      `Only candidate decisions can be approved (current status: ${decision.status})`,
    );
  }

  return mutate(
    {},
    { memexId, docId: decision.docId, entity: "decision", action: "updated" },
    async () => {
      const [updated] = await db
        .update(decisions)
        .set({ status: "open" })
        .where(and(eq(decisions.id, id), eq(decisions.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

export async function rejectDecision(
  memexId: string,
  id: string,
  reason: string,
): Promise<Mutated<Decision>> {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new ValidationError("reason must be a non-empty string");
  }
  const decision = await loadOwnedDecision(memexId, id);
  if (decision.status !== "candidate") {
    throw new ValidationError(
      `Only candidate decisions can be rejected (current status: ${decision.status})`,
    );
  }

  const result = await mutate(
    {},
    { memexId, docId: decision.docId, entity: "decision", action: "updated" },
    async () => {
      const [updated] = await db
        .update(decisions)
        .set({ status: "rejected", resolution: reason.trim(), resolvedAt: new Date() })
        .where(and(eq(decisions.id, id), eq(decisions.memexId, memexId)))
        .returning();
      return updated;
    },
  );
  // Re-embed: rejection writes the reason as resolution text, which is part of
  // the embedded chunk. Even rejected candidates can be search-relevant ("why
  // did we reject the proxy approach?").
  maybeEmbedDecisionInBackground(memexId, id);
  return result;
}

// Service function only; not exposed as MCP tool. Tracked on doc-10 deferral list (item #5).
/**
 * Edit-in-place field updates on a Decision. Does NOT change status — the caller
 * uses reopenDecision / resolveDecision / approveDecision / rejectDecision for
 * transitions. Common use case: tightening the resolution prose on a resolved
 * decision after the agent has gone live, without forcing the Spec back to plan.
 *
 * Mutable fields: title, context, resolution, chosenOptionIndex.
 *
 * Validation:
 *  - empty `resolution` is rejected on resolved decisions (resolution is the
 *    audit trail for the choice; clearing it would lose history)
 *  - `chosenOptionIndex` is range-checked against the decision's current options
 *
 * NOTE: a chosenOptionIndex flip after build is a real scope change — the
 * build-readiness rubric (`assess_spec({mode:'phase',target:'build'})`) ought
 * to detect this and invalidate the narrative anchor, but doesn't today. See
 * scratchpad-wic/memex/todos/decision-prose-is-immutable.md for the follow-up.
 */
export interface UpdateDecisionFields {
  title?: string;
  context?: string | null;
  resolution?: string;
  chosenOptionIndex?: number;
}

export async function updateDecisionFields(
  memexId: string,
  id: string,
  fields: UpdateDecisionFields,
): Promise<Mutated<Decision>> {
  const decision = await loadOwnedDecision(memexId, id);

  const updates: Partial<typeof decisions.$inferInsert> = {};
  if (fields.title !== undefined) {
    if (!fields.title.trim()) {
      throw new ValidationError("title cannot be empty");
    }
    updates.title = fields.title;
  }
  if (fields.context !== undefined) {
    updates.context = fields.context;
  }
  if (fields.resolution !== undefined) {
    if (decision.status === "resolved" && !fields.resolution.trim()) {
      throw new ValidationError(
        "resolution cannot be cleared on a resolved decision; reopen it first to drop the resolution",
      );
    }
    updates.resolution = fields.resolution;
  }
  if (fields.chosenOptionIndex !== undefined) {
    validateChosenIndex(
      decision.options as DecisionOption[] | null,
      fields.chosenOptionIndex,
    );
    updates.chosenOptionIndex = fields.chosenOptionIndex;
  }
  if (Object.keys(updates).length === 0) {
    throw new ValidationError(
      "updateDecisionFields requires at least one of: title, context, resolution, chosenOptionIndex",
    );
  }

  return mutate(
    {},
    { memexId, docId: decision.docId, entity: "decision", action: "updated" },
    async () => {
      const [updated] = await db
        .update(decisions)
        .set(updates)
        .where(and(eq(decisions.id, id), eq(decisions.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

export async function setDecisionOptions(
  memexId: string,
  id: string,
  options: DecisionOption[],
): Promise<Mutated<Decision>> {
  const validated = validateOptions(options);
  const decision = await loadOwnedDecision(memexId, id);
  if (decision.status === "resolved" || decision.status === "rejected") {
    throw new ValidationError(
      `Cannot change options on a ${decision.status} decision; reopen it first`,
    );
  }

  return mutate(
    {},
    { memexId, docId: decision.docId, entity: "decision", action: "updated" },
    async () => {
      const [updated] = await db
        .update(decisions)
        .set({ options: validated })
        .where(and(eq(decisions.id, id), eq(decisions.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

export async function resolveDecision(
  memexId: string,
  id: string,
  resolution: string,
  chosenOptionIndex?: number,
  ctx: RequestCtx = {},
): Promise<Mutated<Decision>> {
  const decision = await loadOwnedDecision(memexId, id);
  // Strict transition: only `open` decisions can be resolved. Candidates need approval
  // first; rejected/resolved decisions can't transition into resolved without going via
  // reopen → open.
  if (decision.status !== "open") {
    throw new ValidationError(
      `Only open decisions can be resolved (current status: ${decision.status})`,
    );
  }

  // spec-209 dec-1: graceful-degrade. A chosenOptionIndex is meaningless on a
  // decision with no options (the common `open`, prose-resolved case), and
  // throwing there was the dominant resolve_decision failure (88% of its errors
  // on prod). Drop the index and resolve on the prose instead. An index on a
  // decision that DOES have options is still validated (out-of-bounds errors).
  // Scoped here only — validateChosenIndex and update_decision are untouched.
  const hasOptions =
    Array.isArray(decision.options) && (decision.options as DecisionOption[]).length > 0;
  const effectiveChosenIndex = hasOptions ? chosenOptionIndex : undefined;
  if (effectiveChosenIndex !== undefined) {
    validateChosenIndex(decision.options as DecisionOption[] | null, effectiveChosenIndex);
  }

  const now = new Date();

  // The cascading docComments update is treated as part of the decision-resolution
  // logical action (not an independent invariant per dec-2): downstream subscribers
  // refetch the whole doc on the decision event, which pulls the new comment state too.
  // Both writes run in one mutate() so a failure in either path emits nothing.
  const updated = await mutate(
    ctx,
    { memexId, docId: decision.docId, entity: "decision", action: "updated" },
    async () => {
      const [row] = await db
        .update(decisions)
        .set({
          status: "resolved",
          resolution,
          resolvedAt: now,
          // spec-122 dec-2/dec-5 — record who resolved it, through which surface.
          ...(await resolveActorColumns(ctx)),
          ...(effectiveChosenIndex !== undefined ? { chosenOptionIndex: effectiveChosenIndex } : {}),
        })
        .where(and(eq(decisions.id, id), eq(decisions.memexId, memexId)))
        .returning();

      // Resolve all open comments on this decision
      await db
        .update(docComments)
        .set({ resolvedAt: now })
        .where(and(eq(docComments.decisionId, id), isNull(docComments.resolvedAt)));
      return row;
    },
  );

  // Decision-triggered standard drift (t-13 / dec-28). Best-effort post-commit
  // side-effect: scan standards in the same account for `[per dec-N]` references and
  // post a typed `drift` comment on each affected section. Re-resolving the same
  // decision is idempotent — the helper checks for an existing drift comment that
  // mentions the handle + the `was resolved` marker before inserting a new one.
  // Errors here are swallowed: the decision resolution is already committed and a
  // drift-scan failure must not propagate (the FTS query, standard mismatch, or
  // comment insertion may fail for reasons unrelated to the decision change). The UI
  // can rediscover drift via list_doc_comments / SSE on subsequent activity.
  try {
    // dec-11: Handhold demo (is_demo) specs are excluded from every agent surface,
    // so resolving a demo decision must NOT trigger a standards drift scan. This is
    // also the primary fix for the spec-178 backfill hang: scanForDecisionDrift is
    // AWAITED here (it runs a standards FTS per resolve), so seeding 5×N demo specs
    // put N× full drift scans on the critical path and stalled the deploy. Skip them.
    const [docRow] = await db
      .select({ isDemo: documents.isDemo })
      .from(documents)
      .where(eq(documents.id, decision.docId))
      .limit(1);
    if (docRow?.isDemo) {
      return updated;
    }
    // Lazy import to avoid any circular dependency surprises (services/standards.ts
    // imports services/comments.ts, which has no path back here, but the lazy load
    // also keeps the cost out of the hot path when no standards exist).
    const { scanForDecisionDrift } = await import("./standards.js");
    await scanForDecisionDrift(memexId, `dec-${updated.seq}`, updated.title);
  } catch (err) {
    // Stay quiet by default; surface only when DEBUG_AGENT logging is on so debugging
    // a misbehaving scan is possible without polluting prod logs.
    if (process.env.DEBUG_AGENT !== "0") {
      // eslint-disable-next-line no-console
      console.error(
        `[AGENT drift-scan] dec-${updated.seq} scan failed (decision still resolved):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Re-embed with the resolution text now in scope (b-34 D-2).
  maybeEmbedDecisionInBackground(memexId, id);
  return updated;
}

export async function reopenDecision(memexId: string, id: string): Promise<Mutated<Decision>> {
  const decision = await loadOwnedDecision(memexId, id);
  // Strict transition: only `resolved` decisions can be reopened. Open decisions are
  // already in the target state; candidate / rejected decisions follow approve/reject
  // workflows instead.
  if (decision.status !== "resolved") {
    throw new ValidationError(
      `Only resolved decisions can be reopened (current status: ${decision.status})`,
    );
  }

  const result = await mutate(
    {},
    { memexId, docId: decision.docId, entity: "decision", action: "updated" },
    async () => {
      const [updated] = await db
        .update(decisions)
        .set({
          status: "open",
          resolution: decision.resolution ? `Proposed: ${decision.resolution}` : null,
          resolvedAt: null,
          // Clear chosen option on reopen — the choice is up for re-evaluation.
          chosenOptionIndex: null,
        })
        .where(and(eq(decisions.id, id), eq(decisions.memexId, memexId)))
        .returning();
      return updated;
    },
  );
  // Resolution text changed (prefixed with "Proposed:") — re-embed.
  maybeEmbedDecisionInBackground(memexId, id);
  return result;
}

// ── Soft delete + restore (b-97) ────────────────────────────
// Decisions are never row-deleted from the table — that would lose
// title/context/options/resolution, all of which are crafted by a human or
// agent and expensive to recreate. Instead `delete_decision` transitions the
// row to `status='deleted'`, captures the prior status in `previousStatus`,
// and listDecisions filters those rows out of the default read path so
// `get_doc` markdown and the REST decision list stop surfacing them.
// Restore is a status transition back via update_decision; the prior status
// rides on `previousStatus` so the caller doesn't have to remember it.
// See dec-2..dec-4 of b-97 for the design choices behind this shape.

const RESTORABLE_STATUSES = ["open", "resolved", "candidate", "rejected"] as const;
type RestorableStatus = (typeof RESTORABLE_STATUSES)[number];

export function isRestorableStatus(value: unknown): value is RestorableStatus {
  return (
    typeof value === "string" &&
    (RESTORABLE_STATUSES as readonly string[]).includes(value)
  );
}

export async function deleteDecision(
  memexId: string,
  id: string,
): Promise<Mutated<Decision>> {
  const decision = await loadOwnedDecision(memexId, id);
  if (decision.status === "deleted") {
    throw new ValidationError("Decision is already deleted");
  }

  // Atomic capture-then-flip: previous_status records the status held at the
  // moment of delete so restoreDecision can return the decision to it without
  // the caller having to remember. Other fields (resolution, options,
  // chosenOptionIndex, resolvedAt) are deliberately preserved — restore must
  // be lossless.
  return mutate(
    {},
    { memexId, docId: decision.docId, entity: "decision", action: "updated" },
    async () => {
      const [updated] = await db
        .update(decisions)
        .set({
          status: "deleted",
          previousStatus: decision.status,
        })
        .where(and(eq(decisions.id, id), eq(decisions.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

export async function restoreDecision(
  memexId: string,
  id: string,
  targetStatus: RestorableStatus,
): Promise<Mutated<Decision>> {
  if (!isRestorableStatus(targetStatus)) {
    throw new ValidationError(
      `Restore target must be one of: ${RESTORABLE_STATUSES.join(", ")}`,
    );
  }
  const decision = await loadOwnedDecision(memexId, id);
  if (decision.status !== "deleted") {
    throw new ValidationError(
      `Only deleted decisions can be restored (current status: ${decision.status})`,
    );
  }

  // Clear previousStatus on restore — once the decision is back in a live
  // status, the prior-status capture has done its job. Any subsequent delete
  // will repopulate it.
  return mutate(
    {},
    { memexId, docId: decision.docId, entity: "decision", action: "updated" },
    async () => {
      const [updated] = await db
        .update(decisions)
        .set({
          status: targetStatus,
          previousStatus: null,
        })
        .where(and(eq(decisions.id, id), eq(decisions.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}
