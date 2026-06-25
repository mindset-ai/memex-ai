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
import { commentTargetToColumns, type CommentTarget } from "../types/comment-target.js";
import { isUuid, parseHandle } from "./shared/identifiers.js";
import { nextSeq, withSeqRetry } from "./shared/sequence.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
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

// spec-375 dry-8 (std-1/std-10): Decision and Task references resolve through
// the SAME shape — a UUID lookup, else a `<Primary>-N`/`<legacy>-N` handle that
// must match exactly one row in the memex (the (memex_id, seq) tuple isn't
// unique because both entities live under exactly one doc but seq is per-doc).
// `resolveChildRef` is that one path; the per-entity differences (which table,
// the accepted handle prefixes, the noun used in every message) ride in a
// descriptor so each former variant is reproduced byte-for-byte. `nounCap` is
// the capitalised noun used in the handle messages (`Decision`/`Task`);
// `handleLabel` is the primary handle form shown in the invalid-reference hint
// (`D-N`/`T-N`). Note that the legacy lowercase prefix (`dec-`/`t-`) is accepted
// on input but never surfaced in the hint — matching the prior behaviour.
interface ChildRefDescriptor {
  /** UUID lookup scoped to (id, memexId). Returns the row id or null. */
  findById(memexId: string, id: string): Promise<{ id: string } | null>;
  /** Handle lookup — every row in the memex with this seq. */
  findManyBySeq(memexId: string, seq: number): Promise<{ id: string }[]>;
  /** Primary handle prefix, e.g. "D-" / "T-". */
  primaryPrefix: string;
  /** Legacy handle prefix accepted on input, e.g. "dec-" / "t-". */
  legacyPrefix: string;
  /** Lowercase noun for the UUID not-found / handle not-found messages. */
  noun: string;
  /** Capitalised noun for the ambiguity message ("Decision"/"Task"). */
  nounCap: string;
  /** Handle form shown in the invalid-reference hint ("D-N"/"T-N"). */
  handleLabel: string;
}

async function resolveChildRef(
  memexId: string,
  raw: string,
  cfg: ChildRefDescriptor,
): Promise<string> {
  if (isUuid(raw)) {
    const row = await cfg.findById(memexId, raw);
    if (!row) throw new NotFoundError(`${cfg.noun} ${raw} not found`);
    return row.id;
  }
  const seq = parseHandle(raw, cfg.primaryPrefix) ?? parseHandle(raw, cfg.legacyPrefix);
  if (seq === null) {
    throw new ValidationError(
      `Invalid ${cfg.noun} reference '${raw}'. Use a UUID or ${cfg.handleLabel} handle.`,
    );
  }
  const matches = await cfg.findManyBySeq(memexId, seq);
  if (matches.length === 0) throw new NotFoundError(`${cfg.noun} handle ${raw} not found`);
  if (matches.length > 1) {
    throw new ValidationError(
      `${cfg.nounCap} handle ${raw} is ambiguous in this memex (${matches.length} matches). Use the ${cfg.noun} UUID instead.`,
    );
  }
  return matches[0].id;
}

const DECISION_REF: ChildRefDescriptor = {
  findById: (memexId, id) =>
    db.query.decisions.findFirst({
      where: and(eq(decisions.id, id), eq(decisions.memexId, memexId)),
      columns: { id: true },
    }) as Promise<{ id: string } | null>,
  findManyBySeq: (memexId, seq) =>
    db.query.decisions.findMany({
      where: and(eq(decisions.memexId, memexId), eq(decisions.seq, seq)),
      columns: { id: true },
    }),
  primaryPrefix: "D-",
  legacyPrefix: "dec-",
  noun: "decision",
  nounCap: "Decision",
  handleLabel: "D-N",
};

const TASK_REF: ChildRefDescriptor = {
  findById: (memexId, id) =>
    db.query.tasks.findFirst({
      where: and(eq(tasks.id, id), eq(tasks.memexId, memexId)),
      columns: { id: true },
    }) as Promise<{ id: string } | null>,
  findManyBySeq: (memexId, seq) =>
    db.query.tasks.findMany({
      where: and(eq(tasks.memexId, memexId), eq(tasks.seq, seq)),
      columns: { id: true },
    }),
  primaryPrefix: "T-",
  legacyPrefix: "t-",
  noun: "task",
  nounCap: "Task",
  handleLabel: "T-N",
};

// Resolve a Decision reference. Accepts a UUID or a `D-N` / `dec-N` handle.
const resolveDecisionRef = (memexId: string, raw: string): Promise<string> =>
  resolveChildRef(memexId, raw, DECISION_REF);

// Resolve a Task reference. Accepts a UUID or a `T-N` / `t-N` handle.
const resolveTaskRef = (memexId: string, raw: string): Promise<string> =>
  resolveChildRef(memexId, raw, TASK_REF);

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

// ── Comment-target descriptor (spec-375 dry-7, std-8) ───────
// The three add/list pairs (section / decision / task) differ only in: which FK
// column the comment carries, how the parent row is resolved to a docId (and the
// not-found message that resolution throws), and which `doc_comments` column the
// list query filters on. The descriptor captures exactly those differences so a
// single add/list code path drives all three; the public functions below stay as
// thin signature-preserving wrappers. Per std-8 every add still flows through
// `mutate()` with the identical `{ memexId, docId, entity: "comment", action }`
// key, and per std-32 the attribution path is unchanged.
//
// Parent lookup quirk preserved verbatim: the SECTION row is fetched by id ONLY
// (sections carry no memexId column), then the parent doc is verified memex-
// scoped — a cross-tenant section id therefore 404s on the parent check. The
// DECISION / TASK rows are memex-scoped in their own lookup. Both 404 with the
// SAME `<Noun> ${id} not found` message they always have.
interface CommentTargetDescriptor {
  /** Build the discriminated CommentTarget for the FK-column mapping. */
  toTarget(targetId: string): CommentTarget;
  /** Resolve targetId → owning docId, or throw the verbatim NotFoundError. */
  resolveDocId(memexId: string, targetId: string): Promise<string>;
  /** The `doc_comments` column the list query filters on. */
  listColumn:
    | typeof docComments.sectionId
    | typeof docComments.decisionId
    | typeof docComments.taskId;
}

const SECTION_TARGET: CommentTargetDescriptor = {
  toTarget: (sectionId) => ({ kind: "section", sectionId }),
  resolveDocId: async (memexId, sectionId) => {
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
    return section.docId;
  },
  listColumn: docComments.sectionId,
};

const DECISION_TARGET: CommentTargetDescriptor = {
  toTarget: (decisionId) => ({ kind: "decision", decisionId }),
  resolveDocId: async (memexId, decisionId) => {
    const dec = await db.query.decisions.findFirst({
      where: and(eq(decisions.id, decisionId), eq(decisions.memexId, memexId)),
    });
    if (!dec) {
      throw new NotFoundError(`Decision ${decisionId} not found`);
    }
    return dec.docId;
  },
  listColumn: docComments.decisionId,
};

const TASK_TARGET: CommentTargetDescriptor = {
  toTarget: (taskId) => ({ kind: "task", taskId }),
  resolveDocId: async (memexId, taskId) => {
    const item = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)),
    });
    if (!item) {
      throw new NotFoundError(`Task ${taskId} not found`);
    }
    return item.docId;
  },
  listColumn: docComments.taskId,
};

// The single add path: resolve docId → mutate(comment created) → seq-retried
// insert carrying the descriptor's FK column. Byte-for-byte the prior per-target
// bodies, just parameterised.
async function addCommentForTarget(
  desc: CommentTargetDescriptor,
  memexId: string,
  targetId: string,
  authorName: string,
  content: string,
  extras?: CommentExtras,
): Promise<Mutated<DocComment>> {
  const norm = await normalizeExtras(memexId, extras);

  const docId = await desc.resolveDocId(memexId, targetId);
  const targetColumns = commentTargetToColumns(desc.toTarget(targetId));

  return mutate(
    {},
    { memexId, docId, entity: "comment", action: "created" },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(docComments, docComments.seq, docComments.docId, docId);
          const [comment] = await db
            .insert(docComments)
            .values({
              memexId,
              docId,
              seq,
              ...targetColumns,
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

// The single list path: chronological comments for one target, type-filtered.
async function listCommentsForTarget(
  desc: CommentTargetDescriptor,
  memexId: string,
  targetId: string,
  opts: ListCommentsOptions = {},
): Promise<DocComment[]> {
  const rows = await db.query.docComments.findMany({
    where: and(eq(desc.listColumn, targetId), eq(docComments.memexId, memexId)),
    orderBy: (comments, { asc }) => [asc(comments.createdAt)],
  });
  return rows.filter((c) => matchesTypeFilter(c, opts.typeFilter));
}

// ── Section comments ────────────────────────────────────────

export async function addComment(
  memexId: string,
  sectionId: string,
  authorName: string,
  content: string,
  extras?: CommentExtras,
): Promise<Mutated<DocComment>> {
  return addCommentForTarget(SECTION_TARGET, memexId, sectionId, authorName, content, extras);
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
  return listCommentsForTarget(SECTION_TARGET, memexId, sectionId, opts);
}

// ── Decision comments ───────────────────────────────────────

export async function addDecisionComment(
  memexId: string,
  decisionId: string,
  authorName: string,
  content: string,
  extras?: CommentExtras,
): Promise<Mutated<DocComment>> {
  return addCommentForTarget(DECISION_TARGET, memexId, decisionId, authorName, content, extras);
}

export async function listDecisionComments(
  memexId: string,
  decisionId: string,
  opts: ListCommentsOptions = {},
): Promise<DocComment[]> {
  return listCommentsForTarget(DECISION_TARGET, memexId, decisionId, opts);
}

// ── Work-item comments ─────────────────────────────────────

export async function addTaskComment(
  memexId: string,
  taskId: string,
  authorName: string,
  content: string,
  extras?: CommentExtras,
): Promise<Mutated<DocComment>> {
  return addCommentForTarget(TASK_TARGET, memexId, taskId, authorName, content, extras);
}

export async function listTaskComments(
  memexId: string,
  taskId: string,
  opts: ListCommentsOptions = {},
): Promise<DocComment[]> {
  return listCommentsForTarget(TASK_TARGET, memexId, taskId, opts);
}

// ── Resolve / unresolve (target-agnostic) ───────────────────

export async function resolveComment(
  memexId: string,
  commentId: string,
  resolution?: string,
  // spec-259 dec-1 / ac-4: resolution is an activity-bearing mutation, so it must
  // carry WHO (std-32). The acting user rides the explicit RequestCtx through
  // mutate() — the route/MCP caller passes restCtx(c)/reqCtx(ctx). It defaults to
  // an empty ctx so unattributed/system callers still resolve (degrading to no
  // actor rather than throwing), matching the rest of the activity contract.
  ctx: RequestCtx = {},
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
    ctx,
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

  // spec-375 dry-7: the three target groups share one shape — fetch the parents
  // ordered by seq, batch-fetch their comments via an unscoped `inArray` on the
  // target FK column (ordered by createdAt), then attach + open/type-filter and
  // drop empty entries. `fetchGroup` runs that once per target; the unscoped
  // comment fetch + the only-when-non-empty guard are reproduced verbatim (the
  // parents are already memex-scoped by docId, so the comment fetch never needs
  // its own memexId filter).
  async function fetchGroup<P extends { id: string }>(
    parents: P[],
    listColumn:
      | typeof docComments.sectionId
      | typeof docComments.decisionId
      | typeof docComments.taskId,
    fkOf: (c: DocComment) => string | null,
  ): Promise<{ parent: P; comments: DocComment[] }[]> {
    const ids = parents.map((p) => p.id);
    const comments =
      ids.length > 0
        ? await db.query.docComments.findMany({
            where: inArray(listColumn, ids),
            orderBy: (c, { asc }) => [asc(c.createdAt)],
          })
        : [];
    return parents
      .map((parent) => ({
        parent,
        comments: applyFilter(comments.filter((c) => fkOf(c) === parent.id)),
      }))
      .filter((e) => e.comments.length > 0);
  }

  const sections = await db.query.docSections.findMany({
    where: eq(docSections.docId, docId),
    orderBy: (s, { asc }) => [asc(s.seq)],
  });
  const docDecisions = await db.query.decisions.findMany({
    where: eq(decisions.docId, docId),
    orderBy: (d, { asc }) => [asc(d.seq)],
  });
  const docTasks = await db.query.tasks.findMany({
    where: eq(tasks.docId, docId),
    orderBy: (w, { asc }) => [asc(w.seq)],
  });

  const [sectionGroups, decisionGroups, taskGroups] = await Promise.all([
    fetchGroup(sections, docComments.sectionId, (c) => c.sectionId),
    fetchGroup(docDecisions, docComments.decisionId, (c) => c.decisionId),
    fetchGroup(docTasks, docComments.taskId, (c) => c.taskId),
  ]);

  return {
    sections: sectionGroups.map(({ parent, comments }) => ({ section: parent, comments })),
    decisions: decisionGroups.map(({ parent, comments }) => ({ decision: parent, comments })),
    tasks: taskGroups.map(({ parent, comments }) => ({ task: parent, comments })),
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
