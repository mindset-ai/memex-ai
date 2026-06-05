import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, docComments, decisions, tasks } from "../db/schema.js";
import type { Doc, DocComment, DocSection, Decision, Task } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import {
  COMMENT_TYPES,
  COMMENT_SOURCES,
  isCommentType,
  isCommentSource,
  type CommentType,
  type CommentSource,
  type CommentAction,
  type CommentAudience,
} from "../types/roles.js";
import { isUuid, parseHandle } from "./shared/identifiers.js";
import { nextSeq, withSeqRetry } from "./shared/sequence.js";
import { mutate, type Mutated } from "./mutate.js";
import {
  hasAnchorMarker,
  insertMarkerAt,
  insertRangeMarkers,
  markerEndGlyph,
  captureSnippet,
  captureRangeSnippet,
  stripMarkersForSeq,
  snapToWordBoundary,
  snapToWordStart,
} from "./geo-anchor.js";

// b-36 T-2: doc_comments now carries (doc_id, seq) so it can mint `c-N`
// handles per-doc. Every insert path uses this helper so the same retry
// behaviour applies under contention (concurrent agents adding comments
// to the same doc).
const DOC_COMMENTS_SEQ_CONSTRAINT = "doc_comments_doc_seq_unique";

// ── Typed-comment extras (t-4 / Section 7 of doc-10) ────────
// The schema carries comment_type + source + four nullable structured FK
// columns for cross_reference targets (reference_brief_id /
// reference_standard_id / reference_decision_id / reference_task_id) — see
// db/schema.ts. Defaults from the DB give us discussion/human for any caller
// that doesn't specify, but the service layer also normalises + validates so
// an invalid value never reaches Postgres.
//
// doc-26 t-5: the legacy opaque (referenceType, referenceId) text pair is
// gone from the input surface. Callers pass UUID OR handle for whichever
// kind they're referencing — the service resolves handles to UUIDs against
// the comment's host memex.

export interface CommentExtras {
  /** Wire format keeps the historic `type` name; persisted as `comment_type`. */
  type?: CommentType;
  source?: CommentSource;
  /** Cross-reference target — Spec. UUID or `doc-N` handle. (Field name `referenceBriefId` preserved as wire format under the b-105 allowlist.) */
  referenceBriefId?: string | null;
  /** Cross-reference target — Standard. UUID or `std-N` handle. */
  referenceStandardId?: string | null;
  /** Cross-reference target — Decision. UUID or `D-N` handle (also accepts legacy `dec-N`). */
  referenceDecisionId?: string | null;
  /** Cross-reference target — Task. UUID or `T-N` handle (also accepts legacy `t-N`). */
  referenceTaskId?: string | null;
  /**
   * spec-100 (geo-comments): anchor this comment to a point in the section's
   * markdown source. `snippet` is the snapshot of surrounding text captured at
   * creation (dec-4). Presence of an anchor makes the comment positioned; its
   * absence leaves it floating (the historic behaviour). The marker glyph
   * written into the section source is derived from the comment's own `c-{seq}`
   * handle — see `markerGlyphFor`.
   */
  anchor?: { snippet: string } | null;
  /** spec-100: reserved for v1+ attention routing. v0 accepts only 'all'. */
  audience?: CommentAudience;
  /**
   * spec-100: system-authored action buttons (Address/Dismiss). Permitted only
   * on `source='agent'` comments in v0 — humans discuss, systems act.
   */
  actions?: CommentAction[] | null;
  /** Author's user id, stamped from the session at creation so ownership
   *  ("delete your own comment") can be enforced later. */
  authorUserId?: string | null;
}

interface NormalizedExtras {
  commentType: CommentType;
  source: CommentSource;
  referenceBriefId: string | null;
  referenceStandardId: string | null;
  referenceDecisionId: string | null;
  referenceTaskId: string | null;
  anchorSnippet: string | null;
  audience: CommentAudience;
  actions: CommentAction[] | null;
  authorUserId: string | null;
}

// spec-100: a comment is anchored (positioned in the section source) iff it
// carries a snapshot snippet. Floating comments leave anchorSnippet null.
export function isAnchored(comment: Pick<DocComment, "anchorSnippet">): boolean {
  return comment.anchorSnippet !== null;
}

// spec-100 (dec-1 amended): the canonical marker glyph for a comment is its END
// sentinel `[^c-{seq}e]` — the token that defines whether the comment is still
// anchored (a range also carries a `[^c-{seq}s]` start sentinel; a legacy point
// comment carries a bare `[^c-{seq}]`). Derived from `seq` (stable for the
// comment's lifetime), so there is no separate marker-id to store or sync.
export function markerGlyphFor(comment: Pick<DocComment, "seq">): string {
  return markerEndGlyph(comment.seq);
}

// spec-100 (dec-1): a comment is orphaned when it was anchored but its marker
// glyph is no longer present in the section source (an edit removed it). The
// comment is NOT auto-resolved — it stays visible and renders its snapshot;
// only the jump affordance is lost. Floating comments are never orphaned.
export function isCommentOrphaned(
  comment: Pick<DocComment, "seq" | "anchorSnippet">,
  sectionContent: string,
): boolean {
  if (!isAnchored(comment)) return false;
  return !hasAnchorMarker(sectionContent, comment.seq);
}

// Resolve a Spec / Standard reference. Accepts a UUID or a handle string
// (`spec-N` / `std-N`). Per b-105 the canonical docType is `spec` — legacy
// aliases are gone. The "brief" discriminator value on the `kind` parameter is
// wire-format (matches the `CommentRefKind` typed-comment shape on the API
// surface) and is preserved under the b-105 allowlist.
async function resolveDocRef(
  memexId: string,
  raw: string,
  kind: "brief" | "standard",
): Promise<string> {
  const isSpecDoc = (dt: string): boolean => dt === "spec";
  if (isUuid(raw)) {
    const doc = await db.query.documents.findFirst({
      where: and(eq(documents.id, raw), eq(documents.memexId, memexId)),
    });
    if (!doc) throw new NotFoundError(`${kind} ${raw} not found`);
    if (kind === "brief" && !isSpecDoc(doc.docType)) {
      throw new ValidationError(`Document ${raw} is a ${doc.docType}, not a spec`);
    }
    if (kind === "standard" && doc.docType !== "standard") {
      throw new ValidationError(`Document ${raw} is a ${doc.docType}, not a standard`);
    }
    return doc.id;
  }
  // Handle path — match on (memex_id, handle). The handle column carries the
  // full prefixed form (`spec-7` for specs, `doc-7` for free-form documents,
  // `std-2` for standards) so a direct equality check works without parsing.
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.handle, raw), eq(documents.memexId, memexId)),
  });
  if (!doc) throw new NotFoundError(`${kind} handle ${raw} not found`);
  if (kind === "brief" && !isSpecDoc(doc.docType)) {
    throw new ValidationError(`Document ${raw} is a ${doc.docType}, not a spec`);
  }
  if (kind === "standard" && doc.docType !== "standard") {
    throw new ValidationError(`Document ${raw} is a ${doc.docType}, not a standard`);
  }
  return doc.id;
}

// Resolve a Decision reference. Accepts a UUID or a `D-N` / `dec-N` handle.
// Handle resolution scopes to memex_id + seq; decisions live under exactly one
// doc but the (memex_id, seq) tuple isn't unique, so a bare handle is allowed
// only when it matches exactly one decision in the memex.
async function resolveDecisionRef(memexId: string, raw: string): Promise<string> {
  if (isUuid(raw)) {
    const dec = await db.query.decisions.findFirst({
      where: and(eq(decisions.id, raw), eq(decisions.memexId, memexId)),
    });
    if (!dec) throw new NotFoundError(`decision ${raw} not found`);
    return dec.id;
  }
  const seq = parseHandle(raw, "D-") ?? parseHandle(raw, "dec-");
  if (seq === null) {
    throw new ValidationError(`Invalid decision reference '${raw}'. Use a UUID or D-N handle.`);
  }
  const matches = await db.query.decisions.findMany({
    where: and(eq(decisions.memexId, memexId), eq(decisions.seq, seq)),
  });
  if (matches.length === 0) throw new NotFoundError(`decision handle ${raw} not found`);
  if (matches.length > 1) {
    throw new ValidationError(
      `Decision handle ${raw} is ambiguous in this memex (${matches.length} matches). Use the decision UUID instead.`,
    );
  }
  return matches[0].id;
}

// Resolve a Task reference. Accepts a UUID or a `T-N` / `t-N` handle. Same
// per-memex ambiguity guard as decisions.
async function resolveTaskRef(memexId: string, raw: string): Promise<string> {
  if (isUuid(raw)) {
    const t = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, raw), eq(tasks.memexId, memexId)),
    });
    if (!t) throw new NotFoundError(`task ${raw} not found`);
    return t.id;
  }
  const seq = parseHandle(raw, "T-") ?? parseHandle(raw, "t-");
  if (seq === null) {
    throw new ValidationError(`Invalid task reference '${raw}'. Use a UUID or T-N handle.`);
  }
  const matches = await db.query.tasks.findMany({
    where: and(eq(tasks.memexId, memexId), eq(tasks.seq, seq)),
  });
  if (matches.length === 0) throw new NotFoundError(`task handle ${raw} not found`);
  if (matches.length > 1) {
    throw new ValidationError(
      `Task handle ${raw} is ambiguous in this memex (${matches.length} matches). Use the task UUID instead.`,
    );
  }
  return matches[0].id;
}

// spec-100: validate + normalise the geo-comment extras. Kept pure (no DB) so
// the rules are unit-testable in isolation from the async reference-resolution
// path. v0 deliberately keeps `audience` reserved (only 'all') and confines
// action buttons to system (agent) comments.
function normalizeGeoExtras(
  source: CommentSource,
  extras?: CommentExtras,
): { anchorSnippet: string | null; audience: CommentAudience; actions: CommentAction[] | null } {
  // Anchor: snippet must be a non-empty string when present.
  let anchorSnippet: string | null = null;
  if (extras?.anchor != null) {
    const snippet = extras.anchor.snippet;
    if (typeof snippet !== "string" || snippet.trim() === "") {
      throw new ValidationError("anchor.snippet must be a non-empty string.");
    }
    anchorSnippet = snippet;
  }

  // Audience: reserved in v0 — only the literal 'all' is accepted. Targeted
  // (userId[]) audiences are v1+ and writing one now is a programming error.
  const audience = extras?.audience ?? "all";
  if (audience !== "all") {
    throw new ValidationError(
      "audience is reserved in v0; only 'all' is accepted (targeted routing is v1+).",
    );
  }

  // Actions: system-authored only. Each action needs a non-empty label + kind;
  // kind='agent' additionally requires a non-empty prompt.
  let actions: CommentAction[] | null = null;
  if (extras?.actions != null) {
    if (source !== "agent") {
      throw new ValidationError(
        "Action buttons are only permitted on system (source='agent') comments in v0.",
      );
    }
    if (!Array.isArray(extras.actions)) {
      throw new ValidationError("actions must be an array.");
    }
    for (const action of extras.actions) {
      if (typeof action.label !== "string" || action.label.trim() === "") {
        throw new ValidationError("Each action requires a non-empty label.");
      }
      if (typeof action.kind !== "string" || action.kind.trim() === "") {
        throw new ValidationError("Each action requires a non-empty kind.");
      }
      if (action.kind === "agent" && (typeof action.prompt !== "string" || action.prompt.trim() === "")) {
        throw new ValidationError("An action of kind 'agent' requires a non-empty prompt.");
      }
    }
    actions = extras.actions;
  }

  return { anchorSnippet, audience, actions };
}

async function normalizeExtras(memexId: string, extras?: CommentExtras): Promise<NormalizedExtras> {
  const commentType = extras?.type ?? "discussion";
  const source = extras?.source ?? "human";
  if (!isCommentType(commentType)) {
    throw new ValidationError(
      `Invalid comment type '${commentType}'. Must be one of: ${COMMENT_TYPES.join(", ")}`,
    );
  }
  if (!isCommentSource(source)) {
    throw new ValidationError(
      `Invalid comment source '${source}'. Must be one of: ${COMMENT_SOURCES.join(", ")}`,
    );
  }

  const { anchorSnippet, audience, actions } = normalizeGeoExtras(source, extras);

  // doc-26 t-5: at most one of the four reference_* fields may be set on a
  // single comment (the DB CHECK enforces this for cross_reference rows). The
  // service layer enforces "at most one" on every write so other commentTypes
  // can't accidentally accumulate references.
  const refsSet = [
    extras?.referenceBriefId,
    extras?.referenceStandardId,
    extras?.referenceDecisionId,
    extras?.referenceTaskId,
  ].filter((v) => v !== undefined && v !== null && v !== "").length;
  if (refsSet > 1) {
    throw new ValidationError(
      "At most one of referenceBriefId / referenceStandardId / referenceDecisionId / referenceTaskId may be set on a single comment.",
    );
  }

  let referenceBriefId: string | null = null;
  let referenceStandardId: string | null = null;
  let referenceDecisionId: string | null = null;
  let referenceTaskId: string | null = null;
  if (extras?.referenceBriefId) {
    referenceBriefId = await resolveDocRef(memexId, extras.referenceBriefId, "brief");
  } else if (extras?.referenceStandardId) {
    referenceStandardId = await resolveDocRef(memexId, extras.referenceStandardId, "standard");
  } else if (extras?.referenceDecisionId) {
    referenceDecisionId = await resolveDecisionRef(memexId, extras.referenceDecisionId);
  } else if (extras?.referenceTaskId) {
    referenceTaskId = await resolveTaskRef(memexId, extras.referenceTaskId);
  }

  return {
    commentType,
    source,
    referenceBriefId,
    referenceStandardId,
    referenceDecisionId,
    referenceTaskId,
    anchorSnippet,
    audience,
    actions,
    authorUserId: extras?.authorUserId ?? null,
  };
}

// ── Cross-reference handle lookup (doc-26 t-5) ──────────────
// Batch-resolve the structured FK columns to current handles so formatters
// can render `Cross-reference: <kind> → <current handle>` without the renderer
// itself knowing how to query the DB. Idempotent — comments without a
// reference column set are simply skipped.

export type CommentRefKind = "brief" | "standard" | "decision" | "task";

export interface CommentRefHandle {
  kind: CommentRefKind;
  handle: string;
}

export async function resolveCommentReferences(
  comments: DocComment[],
): Promise<Map<string, CommentRefHandle>> {
  const out = new Map<string, CommentRefHandle>();
  if (comments.length === 0) return out;

  // Bucket the comment IDs by which kind of reference is set, then a single
  // IN-list query per kind fetches the target handles. The XOR constraint
  // means each comment lands in at most one bucket.
  const briefRefs: { commentId: string; targetId: string }[] = [];
  const standardRefs: { commentId: string; targetId: string }[] = [];
  const decisionRefs: { commentId: string; targetId: string }[] = [];
  const taskRefs: { commentId: string; targetId: string }[] = [];

  for (const c of comments) {
    if (c.referenceBriefId) briefRefs.push({ commentId: c.id, targetId: c.referenceBriefId });
    else if (c.referenceStandardId) standardRefs.push({ commentId: c.id, targetId: c.referenceStandardId });
    else if (c.referenceDecisionId) decisionRefs.push({ commentId: c.id, targetId: c.referenceDecisionId });
    else if (c.referenceTaskId) taskRefs.push({ commentId: c.id, targetId: c.referenceTaskId });
  }

  if (briefRefs.length > 0 || standardRefs.length > 0) {
    const docIds = [
      ...briefRefs.map((r) => r.targetId),
      ...standardRefs.map((r) => r.targetId),
    ];
    const docs = await db.query.documents.findMany({
      where: inArray(documents.id, docIds),
      columns: { id: true, handle: true, docType: true },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    for (const r of briefRefs) {
      const d = byId.get(r.targetId);
      // Specs and free-form documents share the `doc-N` handle namespace; we
      // just trust the stored handle column either way. `kind: "brief"` is the
      // wire-format discriminator preserved under the b-105 allowlist.
      if (d) out.set(r.commentId, { kind: "brief", handle: d.handle });
    }
    for (const r of standardRefs) {
      const d = byId.get(r.targetId);
      if (d) out.set(r.commentId, { kind: "standard", handle: d.handle });
    }
  }

  if (decisionRefs.length > 0) {
    const ids = decisionRefs.map((r) => r.targetId);
    const decs = await db.query.decisions.findMany({
      where: inArray(decisions.id, ids),
      columns: { id: true, seq: true },
    });
    const byId = new Map(decs.map((d) => [d.id, d]));
    for (const r of decisionRefs) {
      const d = byId.get(r.targetId);
      if (d) out.set(r.commentId, { kind: "decision", handle: `D-${d.seq}` });
    }
  }

  if (taskRefs.length > 0) {
    const ids = taskRefs.map((r) => r.targetId);
    const ts = await db.query.tasks.findMany({
      where: inArray(tasks.id, ids),
      columns: { id: true, seq: true },
    });
    const byId = new Map(ts.map((t) => [t.id, t]));
    for (const r of taskRefs) {
      const t = byId.get(r.targetId);
      if (t) out.set(r.commentId, { kind: "task", handle: `T-${t.seq}` });
    }
  }

  return out;
}

// ── Helpers ─────────────────────────────────────────────────

/** Resolve the parent document for a comment target (section, decision, or task). */
export async function getDocForTarget(
  memexId: string,
  target: { sectionId?: string; decisionId?: string; taskId?: string },
): Promise<Doc> {
  let docId: string | undefined;
  if (target.sectionId) {
    const section = await db.query.docSections.findFirst({
      where: eq(docSections.id, target.sectionId),
    });
    docId = section?.docId;
  } else if (target.decisionId) {
    const dec = await db.query.decisions.findFirst({
      where: and(eq(decisions.id, target.decisionId), eq(decisions.memexId, memexId)),
    });
    docId = dec?.docId;
  } else if (target.taskId) {
    const item = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, target.taskId), eq(tasks.memexId, memexId)),
    });
    docId = item?.docId;
  }
  if (!docId) {
    throw new NotFoundError("Comment target not found");
  }
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError("Comment target not found");
  }
  return doc;
}

export async function getDocForComment(
  memexId: string,
  comment: DocComment,
): Promise<Doc> {
  return getDocForTarget(memexId, {
    sectionId: comment.sectionId ?? undefined,
    decisionId: comment.decisionId ?? undefined,
    taskId: comment.taskId ?? undefined,
  });
}

/** Resolve the docId for a comment by checking which target FK is set. */
async function getDocIdForComment(comment: DocComment): Promise<string | null> {
  if (comment.sectionId) {
    const section = await db.query.docSections.findFirst({
      where: eq(docSections.id, comment.sectionId),
    });
    return section?.docId ?? null;
  }
  if (comment.decisionId) {
    const dec = await db.query.decisions.findFirst({
      where: eq(decisions.id, comment.decisionId),
    });
    return dec?.docId ?? null;
  }
  if (comment.taskId) {
    const item = await db.query.tasks.findFirst({
      where: eq(tasks.id, comment.taskId),
    });
    return item?.docId ?? null;
  }
  return null;
}

// ── Listing options (t-4) ───────────────────────────────────

export interface ListCommentsOptions {
  /**
   * Restrict results to one or more comment types. Omit to return all types.
   * Used by review_doc_comments to default-exclude `progress` (noisy for humans),
   * by the typed-comment UI tabs, and by drift / question / readiness queries.
   */
  typeFilter?: CommentType | CommentType[];
}

function matchesTypeFilter(
  comment: DocComment,
  typeFilter?: CommentType | CommentType[],
): boolean {
  if (typeFilter === undefined) return true;
  const allowed = Array.isArray(typeFilter) ? typeFilter : [typeFilter];
  return allowed.includes(comment.commentType as CommentType);
}

// ── Section comments ────────────────────────────────────────

export async function addComment(
  memexId: string,
  sectionId: string,
  authorName: string,
  content: string,
  extras?: CommentExtras,
): Promise<Mutated<DocComment>> {
  const norm = await normalizeExtras(memexId, extras);

  const section = await db.query.docSections.findFirst({
    where: eq(docSections.id, sectionId),
  });
  if (!section) {
    throw new NotFoundError(`Section ${sectionId} not found`);
  }
  // Verify the parent doc belongs to the requesting account
  const parent = await db.query.documents.findFirst({
    where: and(eq(documents.id, section.docId), eq(documents.memexId, memexId)),
  });
  if (!parent) {
    throw new NotFoundError(`Section ${sectionId} not found`);
  }

  return mutate(
    {},
    { memexId, docId: section.docId, entity: "comment", action: "created" },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(
            docComments,
            docComments.seq,
            docComments.docId,
            section.docId,
          );
          const [comment] = await db
            .insert(docComments)
            .values({
              memexId,
              docId: section.docId,
              seq,
              sectionId,
              authorName,
              content,
              ...norm,
            })
            .returning();
          return comment;
        },
        DOC_COMMENTS_SEQ_CONSTRAINT,
      ),
  );
}

// spec-100: create a geo-comment anchored to a RANGE in a section's markdown.
// `anchorOffset` is the END of the selection (character index into the source);
// `anchorStartOffset`, when supplied, is the START — together they bracket the
// selected region with `[^c-Ns]…[^c-Ne]` sentinels. When the start is omitted
// (or not before the end) the comment degrades to a single end-sentinel POINT
// anchor (used by the MCP `add_comment` tool, which has no selection span). The
// snapshot (dec-4) is captured server-side — the selected text for a range, the
// surrounding sentence for a point — so it reflects exactly what was rendered at
// creation time. Sentinels + comment row are written in a single transaction so
// the source can never carry a marker for a comment that failed to persist (or
// vice versa). Emits two bus events: the comment create and the section update.
export async function addAnchoredComment(
  memexId: string,
  sectionId: string,
  authorName: string,
  content: string,
  anchorOffset: number,
  extras?: Omit<CommentExtras, "anchor">,
  anchorStartOffset?: number,
): Promise<Mutated<DocComment>> {
  const section = await db.query.docSections.findFirst({
    where: eq(docSections.id, sectionId),
  });
  if (!section) {
    throw new NotFoundError(`Section ${sectionId} not found`);
  }
  const parent = await db.query.documents.findFirst({
    where: and(eq(documents.id, section.docId), eq(documents.memexId, memexId)),
  });
  if (!parent) {
    throw new NotFoundError(`Section ${sectionId} not found`);
  }

  // Snap each end of the selection to a word boundary so a sentinel never lands
  // mid-word (start retreats to the word's start, end advances to its end), then
  // derive the snapshot (dec-4) from the SAME snapped offsets. A range needs the
  // start before the end; otherwise we treat it as a point at the end offset.
  const endOffset = snapToWordBoundary(section.content, anchorOffset);
  const startOffset =
    anchorStartOffset != null ? snapToWordStart(section.content, anchorStartOffset) : null;
  const isRange = startOffset != null && startOffset < endOffset;
  const snapshot = isRange
    ? captureRangeSnippet(section.content, startOffset, endOffset)
    : captureSnippet(section.content, endOffset);
  const norm = await normalizeExtras(memexId, { ...extras, anchor: { snippet: snapshot } });
  const docId = section.docId;

  return mutate(
    {},
    [
      { memexId, docId, entity: "comment", action: "created" },
      { memexId, docId, entity: "section", action: "updated" },
    ],
    async () =>
      withSeqRetry(async () => {
        const seq = await nextSeq(docComments, docComments.seq, docComments.docId, docId);
        // Range → both sentinels around the selection; point → a single end
        // sentinel (no start sibling, so the client highlights its sentence).
        const newContent = isRange
          ? insertRangeMarkers(section.content, startOffset, endOffset, seq)
          : insertMarkerAt(section.content, endOffset, markerEndGlyph(seq));

        return db.transaction(async (tx) => {
          await tx
            .update(docSections)
            .set({ content: newContent, updatedAt: new Date() })
            .where(eq(docSections.id, sectionId));
          const [comment] = await tx
            .insert(docComments)
            .values({ memexId, docId, seq, sectionId, authorName, content, ...norm })
            .returning();
          return comment;
        });
      }, DOC_COMMENTS_SEQ_CONSTRAINT),
  );
}

export async function listComments(
  memexId: string,
  sectionId: string,
  opts: ListCommentsOptions = {},
): Promise<DocComment[]> {
  const rows = await db.query.docComments.findMany({
    where: and(eq(docComments.sectionId, sectionId), eq(docComments.memexId, memexId)),
    orderBy: (comments, { asc }) => [asc(comments.createdAt)],
  });
  return rows.filter((c) => matchesTypeFilter(c, opts.typeFilter));
}

// ── Decision comments ───────────────────────────────────────

export async function addDecisionComment(
  memexId: string,
  decisionId: string,
  authorName: string,
  content: string,
  extras?: CommentExtras,
): Promise<Mutated<DocComment>> {
  const norm = await normalizeExtras(memexId, extras);

  const dec = await db.query.decisions.findFirst({
    where: and(eq(decisions.id, decisionId), eq(decisions.memexId, memexId)),
  });
  if (!dec) {
    throw new NotFoundError(`Decision ${decisionId} not found`);
  }

  return mutate(
    {},
    { memexId, docId: dec.docId, entity: "comment", action: "created" },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(
            docComments,
            docComments.seq,
            docComments.docId,
            dec.docId,
          );
          const [comment] = await db
            .insert(docComments)
            .values({
              memexId,
              docId: dec.docId,
              seq,
              decisionId,
              authorName,
              content,
              ...norm,
            })
            .returning();
          return comment;
        },
        DOC_COMMENTS_SEQ_CONSTRAINT,
      ),
  );
}

export async function listDecisionComments(
  memexId: string,
  decisionId: string,
  opts: ListCommentsOptions = {},
): Promise<DocComment[]> {
  const rows = await db.query.docComments.findMany({
    where: and(eq(docComments.decisionId, decisionId), eq(docComments.memexId, memexId)),
    orderBy: (comments, { asc }) => [asc(comments.createdAt)],
  });
  return rows.filter((c) => matchesTypeFilter(c, opts.typeFilter));
}

// ── Work-item comments ─────────────────────────────────────

export async function addTaskComment(
  memexId: string,
  taskId: string,
  authorName: string,
  content: string,
  extras?: CommentExtras,
): Promise<Mutated<DocComment>> {
  const norm = await normalizeExtras(memexId, extras);

  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)),
  });
  if (!item) {
    throw new NotFoundError(`Task ${taskId} not found`);
  }

  return mutate(
    {},
    { memexId, docId: item.docId, entity: "comment", action: "created" },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(
            docComments,
            docComments.seq,
            docComments.docId,
            item.docId,
          );
          const [comment] = await db
            .insert(docComments)
            .values({
              memexId,
              docId: item.docId,
              seq,
              taskId,
              authorName,
              content,
              ...norm,
            })
            .returning();
          return comment;
        },
        DOC_COMMENTS_SEQ_CONSTRAINT,
      ),
  );
}

export async function listTaskComments(
  memexId: string,
  taskId: string,
  opts: ListCommentsOptions = {},
): Promise<DocComment[]> {
  const rows = await db.query.docComments.findMany({
    where: and(eq(docComments.taskId, taskId), eq(docComments.memexId, memexId)),
    orderBy: (comments, { asc }) => [asc(comments.createdAt)],
  });
  return rows.filter((c) => matchesTypeFilter(c, opts.typeFilter));
}

// ── Resolve / unresolve (target-agnostic) ───────────────────

export async function resolveComment(
  memexId: string,
  commentId: string,
  resolution?: string,
): Promise<Mutated<DocComment>> {
  // Pre-load to fail fast on the FK lookup before opening the mutate transaction.
  const existing = await db.query.docComments.findFirst({
    where: and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)),
  });
  if (!existing) {
    throw new NotFoundError(`Comment ${commentId} not found`);
  }
  const docId = (await getDocIdForComment(existing)) ?? undefined;

  return mutate(
    {},
    { memexId, docId, entity: "comment", action: "updated" },
    async () => {
      const [updated] = await db
        .update(docComments)
        .set({
          resolvedAt: new Date(),
          ...(resolution !== undefined ? { resolution } : {}),
        })
        .where(and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

// spec-100: delete a comment you authored. Ownership is enforced here
// (authorUserId must match the requester); the route surfaces a 403 otherwise.
// If the comment was anchored, its `[^c-N]` marker is stripped from the section
// source in the same transaction so no orphaned glyph is left behind.
export async function deleteComment(
  memexId: string,
  commentId: string,
  requestingUserId: string | null,
): Promise<Mutated<{ id: string }>> {
  const existing = await db.query.docComments.findFirst({
    where: and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)),
  });
  if (!existing) {
    throw new NotFoundError(`Comment ${commentId} not found`);
  }
  if (!requestingUserId || existing.authorUserId !== requestingUserId) {
    throw new ValidationError("You can only delete your own comments.");
  }

  const docId = existing.docId;
  const anchored = existing.sectionId != null && existing.anchorSnippet != null;

  return mutate(
    {},
    anchored
      ? [
          { memexId, docId, entity: "comment", action: "deleted" },
          { memexId, docId, entity: "section", action: "updated" },
        ]
      : { memexId, docId, entity: "comment", action: "deleted" },
    async () =>
      db.transaction(async (tx) => {
        if (anchored && existing.sectionId) {
          const section = await tx.query.docSections.findFirst({
            where: eq(docSections.id, existing.sectionId),
          });
          if (section) {
            const stripped = stripMarkersForSeq(section.content, existing.seq);
            if (stripped !== section.content) {
              await tx
                .update(docSections)
                .set({ content: stripped, updatedAt: new Date() })
                .where(eq(docSections.id, existing.sectionId));
            }
          }
        }
        await tx.delete(docComments).where(eq(docComments.id, commentId));
        return { id: commentId };
      }),
  );
}

export async function unresolveComment(
  memexId: string,
  commentId: string,
): Promise<Mutated<DocComment>> {
  const existing = await db.query.docComments.findFirst({
    where: and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)),
  });
  if (!existing) {
    throw new NotFoundError(`Comment ${commentId} not found`);
  }
  const docId = (await getDocIdForComment(existing)) ?? undefined;

  return mutate(
    {},
    { memexId, docId, entity: "comment", action: "updated" },
    async () => {
      const [updated] = await db
        .update(docComments)
        .set({ resolvedAt: null, resolution: null })
        .where(and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

// ── Document-level queries ──────────────────────────────────

export interface DocCommentsResult {
  sections: { section: DocSection; comments: DocComment[] }[];
  decisions: { decision: Decision; comments: DocComment[] }[];
  tasks: { task: Task; comments: DocComment[] }[];
}

async function getDocCommentsGrouped(
  memexId: string,
  docId: string,
  filter: "all" | "open",
  opts: ListCommentsOptions = {},
): Promise<DocCommentsResult> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Document ${docId} not found`);
  }

  const applyFilter = (comments: DocComment[]) => {
    const byOpen = filter === "open" ? comments.filter((c) => !c.resolvedAt) : comments;
    return byOpen.filter((c) => matchesTypeFilter(c, opts.typeFilter));
  };

  // Section comments
  const sections = await db.query.docSections.findMany({
    where: eq(docSections.docId, docId),
    orderBy: (s, { asc }) => [asc(s.seq)],
  });
  const sectionIds = sections.map((s) => s.id);
  const sectionComments = sectionIds.length > 0
    ? await db.query.docComments.findMany({
        where: inArray(docComments.sectionId, sectionIds),
        orderBy: (c, { asc }) => [asc(c.createdAt)],
      })
    : [];

  // Decision comments
  const docDecisions = await db.query.decisions.findMany({
    where: eq(decisions.docId, docId),
    orderBy: (d, { asc }) => [asc(d.seq)],
  });
  const decisionIds = docDecisions.map((d) => d.id);
  const decisionComments = decisionIds.length > 0
    ? await db.query.docComments.findMany({
        where: inArray(docComments.decisionId, decisionIds),
        orderBy: (c, { asc }) => [asc(c.createdAt)],
      })
    : [];

  // Work-item comments
  const docTasks = await db.query.tasks.findMany({
    where: eq(tasks.docId, docId),
    orderBy: (w, { asc }) => [asc(w.seq)],
  });
  const taskIds = docTasks.map((w) => w.id);
  const taskComments = taskIds.length > 0
    ? await db.query.docComments.findMany({
        where: inArray(docComments.taskId, taskIds),
        orderBy: (c, { asc }) => [asc(c.createdAt)],
      })
    : [];

  return {
    sections: sections
      .map((section) => ({
        section,
        comments: applyFilter(sectionComments.filter((c) => c.sectionId === section.id)),
      }))
      .filter((e) => e.comments.length > 0),
    decisions: docDecisions
      .map((decision) => ({
        decision,
        comments: applyFilter(decisionComments.filter((c) => c.decisionId === decision.id)),
      }))
      .filter((e) => e.comments.length > 0),
    tasks: docTasks
      .map((task) => ({
        task,
        comments: applyFilter(taskComments.filter((c) => c.taskId === task.id)),
      }))
      .filter((e) => e.comments.length > 0),
  };
}

export async function listCommentsForDoc(
  memexId: string,
  docId: string,
  opts: ListCommentsOptions = {},
): Promise<DocCommentsResult> {
  return getDocCommentsGrouped(memexId, docId, "all", opts);
}

export async function reviewDocComments(
  memexId: string,
  docId: string,
  opts: ListCommentsOptions = {},
): Promise<DocCommentsResult> {
  return getDocCommentsGrouped(memexId, docId, "open", opts);
}

export async function getCommentCountsForDoc(
  memexId: string,
  entityIds: string[],
): Promise<Record<string, number>> {
  if (entityIds.length === 0) return {};

  const openComments = await db.query.docComments.findMany({
    where: and(isNull(docComments.resolvedAt), eq(docComments.memexId, memexId)),
    columns: { sectionId: true, decisionId: true, taskId: true },
  });

  const counts: Record<string, number> = {};
  for (const c of openComments) {
    const targetId = c.sectionId ?? c.decisionId ?? c.taskId;
    if (targetId && entityIds.includes(targetId)) {
      counts[targetId] = (counts[targetId] ?? 0) + 1;
    }
  }
  return counts;
}
