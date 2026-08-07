// spec-521 dec-5 (ac-7, ac-15) — Spec supersession, doc-level only.
//
// WHY THIS EXISTS. Archive answers "this is dead." It does not answer "this
// shipped, and a later Spec changed it" — that Spec is real history you do not want
// forgotten, but its prose is no longer true. Four independent workarounds for the
// missing concept already existed in this Memex (state in the title, supersession
// recorded in the SUCCESSOR's title while the predecessor stayed active,
// hand-written "Reconciliation with spec-N" sections, an "On Ice" tag), which is the
// tell that the model was missing a primitive. People were already typing this fact;
// supersede_spec catches the keystroke as data.
//
// WHY IT IS AGENT-CALLABLE WHILE ARCHIVING IS NOT (dec-6). Supersession WITHHOLDS
// NOTHING — it adds a pointer, serves the full content, and clears with one call.
// Archiving withholds content from every agent surface, and that judgement belongs
// to a person. The asymmetry in authority follows the asymmetry in consequence.
//
// DOC-LEVEL ONLY (dec-5). No decision, section or other child entity carries its own
// pointer. Decision-level would have to be honoured in all thirteen decision read
// paths — `agent/context-builder.ts` among them, which builds the in-app agent's
// Document Context — and a marker honoured in twelve of thirteen is worse than no
// marker, because people learn to trust it and it is absent exactly when it matters.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, type Doc } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";

/**
 * ac-15 / §5.4 — the supersession note is capped at the same length as the archive
 * reason, for the same reason: it is a POINTER, not a place to re-argue the Spec. If
 * the successor needs explaining, that explanation belongs in the successor.
 */
export const SUPERSESSION_NOTE_MAX_LENGTH = 280;

/**
 * Guard against walking a pre-existing cycle forever. A cycle cannot be created
 * through `supersedeSpec` (the walk below refuses it), so this bound should be
 * unreachable — it exists so a row hand-edited in SQL cannot hang a request.
 */
const MAX_CHAIN_DEPTH = 64;

/** Absolute date for the lead line — "5 Aug 2026". UTC, so the rendering never
 *  depends on the reading server's timezone. */
function formatSupersessionDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * ac-7 / §5.4 — the ONE line that must lead every read of a superseded Spec: the
 * Spec itself, its decisions, its ACs, its tasks, its comments. "The pointer is
 * worthless if a read can miss it", so this is composed in a single place and
 * attached at the single envelope seat (`composeGuidanceEnvelope`) rather than by
 * each handler.
 *
 * Content is served unchanged beneath it — a superseded Spec is history, not a
 * secret. That is the whole difference from archive, and why Option C for archive
 * ("serve it behind a banner") was rejected there but is exactly right here: an
 * agent CAN be trusted to prefer the successor when the content it is reading is
 * still true history, whereas it cannot be trusted to discount parked intent.
 */
export function formatSupersessionLead(
  successorHandle: string,
  supersededAt: Date | null,
  note: string | null,
): string {
  const when = supersededAt ? ` (${formatSupersessionDate(supersededAt)})` : "";
  const why = note?.trim() ? `: ${note.trim()}` : "";
  return (
    `⚠ SUPERSEDED BY ${successorHandle}${when}${why}\n` +
    `Read ${successorHandle} for current intent; do not reconcile against this Spec.`
  );
}

/**
 * ac-7 — the mirror the SUCCESSOR carries. One line however many predecessors, so a
 * Spec that absorbed five others does not open with five lines of bookkeeping.
 */
export function formatReplacesLead(predecessorHandles: string[]): string {
  if (predecessorHandles.length === 0) return "";
  return `Replaces ${predecessorHandles.join(", ")}.`;
}

/**
 * spec-521 ac-13 (std-39 cl-5) — successor HANDLE per doc, in ONE query for a whole
 * page of rows.
 *
 * `list_docs` marks every superseded row with its successor. Resolving that per row
 * would be an N+1 on a listing dec-3 has just widened to several hundred rows, so the
 * lookup is batched: collect the distinct successor ids off the rows we already have
 * in memory, fetch their handles in a single `inArray`, and map back.
 *
 * Takes the already-fetched rows rather than re-reading them — the caller has them,
 * and a second read of the same set would be the cost this exists to avoid. Returns
 * docId → successor handle, omitting docs that are not superseded (the common case).
 */
export async function successorHandlesByDoc(
  memexId: string,
  // Optional on the field because DocSummary carries it optionally (older
  // constructors and legacy payloads omit it); an absent pointer reads the same as a
  // null one — not superseded.
  docs: { id: string; supersededByDocId?: string | null }[],
): Promise<Map<string, string>> {
  const successorIds = [
    ...new Set(
      docs.map((d) => d.supersededByDocId).filter((id): id is string => Boolean(id)),
    ),
  ];
  if (successorIds.length === 0) return new Map();
  const rows = await db
    .select({ id: documents.id, handle: documents.handle })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), inArray(documents.id, successorIds)));
  const handleById = new Map(rows.map((r) => [r.id, r.handle]));
  const out = new Map<string, string>();
  for (const d of docs) {
    const handle = d.supersededByDocId ? handleById.get(d.supersededByDocId) : undefined;
    if (handle) out.set(d.id, handle);
  }
  return out;
}

/** The Specs this doc supersedes — the reverse lookup the mirror line needs, and the
 *  query the partial index on superseded_by_doc_id exists to serve (std-39). */
export async function listPredecessors(memexId: string, docId: string): Promise<Doc[]> {
  return db.query.documents.findMany({
    where: and(
      eq(documents.memexId, memexId),
      eq(documents.supersededByDocId, docId),
    ),
  });
}

/**
 * Walk the supersession chain from `startDocId` and report whether it reaches
 * `targetDocId`. Used to refuse a cycle at write (ac-15) — "a pointer into a loop is
 * worse than none".
 */
async function chainReaches(startDocId: string, targetDocId: string): Promise<boolean> {
  let cursor: string | null = startDocId;
  for (let depth = 0; cursor && depth < MAX_CHAIN_DEPTH; depth++) {
    if (cursor === targetDocId) return true;
    const row: { supersededByDocId: string | null } | undefined =
      await db.query.documents.findFirst({
        where: eq(documents.id, cursor),
        columns: { supersededByDocId: true },
      });
    cursor = row?.supersededByDocId ?? null;
  }
  return false;
}

/**
 * Record (or clear) that `docId` is superseded by `supersededByDocId`.
 *
 * Pass `supersededByDocId: null` to CLEAR — it nulls all three columns in one call
 * (ac-15), because a pointer recorded in error must be as cheap to remove as it was
 * to add. That is what makes it safe for an agent to record one.
 *
 * std-8: the write goes through `mutate()` and emits `document.updated` on the
 * unified bus, so the Spec page picks the banner up live rather than on refresh.
 * std-32: the ctx is explicit and carries a real channel — an agent-set supersession
 * must read as `mcp`, never a defaulted `server`.
 */
export async function supersedeSpec(
  memexId: string,
  docId: string,
  supersededByDocId: string | null,
  note: string | null,
  ctx: RequestCtx,
): Promise<Mutated<Doc>> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    // std-10 cl-15/cl-47: no UUID in a message that can reach the agent boundary. The
    // caller already holds the ref it passed, so naming the id adds nothing for a
    // human and leaks an internal key to an agent. (Defensive branch: the handler
    // resolves the ref before calling this.)
    throw new NotFoundError("Spec not found.");
  }
  if (doc.docType !== "spec") {
    throw new ValidationError(
      `Supersession applies to Specs only — ${doc.handle} is a ${doc.docType}.`,
    );
  }

  // ── CLEARING ────────────────────────────────────────────────────────────────
  if (supersededByDocId === null) {
    return mutate(
      ctx,
      { memexId, docId, entity: "document", action: "updated" },
      async () => {
        const [updated] = await db
          .update(documents)
          .set({ supersededByDocId: null, supersededAt: null, supersessionNote: null })
          .where(and(eq(documents.id, docId), eq(documents.memexId, memexId)))
          .returning();
        return updated;
      },
    );
  }

  // ── GUARDS (ac-15) ──────────────────────────────────────────────────────────
  // Not itself. Checked before the DB read so the message is unambiguous.
  if (docId === supersededByDocId) {
    throw new ValidationError(
      `A Spec cannot supersede itself (${doc.handle}).`,
    );
  }

  const trimmedNote = note?.trim() || null;
  if (trimmedNote && trimmedNote.length > SUPERSESSION_NOTE_MAX_LENGTH) {
    throw new ValidationError(
      `Supersession note must be ${SUPERSESSION_NOTE_MAX_LENGTH} characters or fewer (got ${trimmedNote.length}).`,
    );
  }

  // Same Memex. std-36: RLS is ENABLE not FORCE, so the tenant policy is NOT the
  // thing standing between these two rows — this check is asserted in code
  // deliberately, not left to the policy. A successor in another Memex would also
  // render as an unresolvable handle in the lead line.
  const successor = await db.query.documents.findFirst({
    where: and(eq(documents.id, supersededByDocId), eq(documents.memexId, memexId)),
  });
  if (!successor) {
    // std-7: a doc outside this Memex is reported as absent, never as forbidden — the
    // caller learns nothing about whether it exists elsewhere.
    // std-10: no UUID in the message.
    throw new NotFoundError("The Spec named as the successor was not found in this Memex.");
  }
  if (successor.docType !== "spec") {
    throw new ValidationError(
      `Supersession applies to Specs only — ${successor.handle} is a ${successor.docType}.`,
    );
  }

  // The successor must be somewhere worth pointing at. A pointer into a black hole
  // is worse than no pointer: it sends the reader to a Spec that is itself parked or
  // itself out of date, and they have no way to tell from the line they were given.
  if (successor.archivedAt) {
    throw new ValidationError(
      `${successor.handle} is archived, so it cannot supersede ${doc.handle} — pointing at withheld content is worse than no pointer.`,
    );
  }
  if (successor.supersededAt) {
    throw new ValidationError(
      `${successor.handle} is itself superseded, so it cannot supersede ${doc.handle} — point at the Spec that carries current intent instead.`,
    );
  }

  // No cycles. Walking FROM the successor: if the chain gets back to this doc, the
  // link would close a loop. Many-to-one is untouched by this — several Specs may
  // point at one successor, which creates no cycle.
  if (await chainReaches(successor.id, docId)) {
    throw new ValidationError(
      `Superseding ${doc.handle} by ${successor.handle} would create a cycle — ${successor.handle}'s own supersession chain already leads back to ${doc.handle}.`,
    );
  }

  return mutate(
    ctx,
    { memexId, docId, entity: "document", action: "updated" },
    async () => {
      const [updated] = await db
        .update(documents)
        .set({
          supersededByDocId: successor.id,
          supersededAt: new Date(),
          supersessionNote: trimmedNote,
        })
        .where(and(eq(documents.id, docId), eq(documents.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}
