import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections } from "../db/schema.js";
import type { DocSection } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { resolveActorColumns } from "./actor.js";
import { nextSeq, withSeqRetry } from "./shared/sequence.js";
import { pgError } from "./shared/pg-error.js";
import { embedAndStoreSection } from "./memex-embeddings.js";

// b-36 T-2: doc_sections's per-doc seq unique constraint was renamed from
// `doc_sections_doc_id_seq_unique` to match the new `doc_<table>_doc_seq_unique`
// convention. addSection wraps insert in withSeqRetry so concurrent inserts
// under the same doc don't fail outright on the read-then-write race.
const DOC_SECTIONS_SEQ_CONSTRAINT = "doc_sections_doc_seq_unique";

function isDocSeqConflict(err: unknown): boolean {
  const e = pgError(err);
  if (!e) return false;
  if (e.constraint_name === DOC_SECTIONS_SEQ_CONSTRAINT) return true;
  return typeof e.message === "string" && e.message.includes(DOC_SECTIONS_SEQ_CONSTRAINT);
}

// Fire-and-forget embed for a section that just changed. Per b-34 every
// docType's sections flow through the embed pipeline (no short-circuit on
// docType). We pass memexId for defence-in-depth — the helper filters its
// lookup by memex_id so a stray caller can't re-embed a stranger's section
// by UUID. We swallow rejections — embedding failure must never surface as
// a failed section write (best-effort contract).
function maybeEmbedSectionInBackground(memexId: string, sectionId: string): void {
  void embedAndStoreSection(sectionId, { memexId }).catch(() => {
    // already logged inside the helper; nothing more to do.
  });
}

// spec-161: the section-write doc-type gate. A standard is authored as clauses, every
// other doc type as a prose `content` blob. This pure decision is extracted so the
// truth table is unit-testable without the MCP tool harness. Throws a redirecting
// ValidationError on a mismatch; returns which input mode the caller must use.
export type SectionWriteMode = "content" | "clauses";

export function resolveSectionWriteMode(args: {
  isStandard: boolean;
  hasContent: boolean;
  hasClauses: boolean;
}): SectionWriteMode {
  const { isStandard, hasContent, hasClauses } = args;
  if (hasContent && hasClauses) {
    throw new ValidationError("Pass exactly one of `content` or `clauses`, not both.");
  }
  if (isStandard) {
    if (hasContent) {
      throw new ValidationError(
        "Standards are authored as clauses. Pass `clauses` (an array of one-aspect clause bodies), not `content`.",
      );
    }
    if (!hasClauses) {
      throw new ValidationError(
        "A standard section needs `clauses` — an array of one-aspect clause bodies.",
      );
    }
    return "clauses";
  }
  if (hasClauses) {
    throw new ValidationError(
      "Only standards have clauses. Pass `content` (markdown body) for this document type.",
    );
  }
  if (!hasContent) {
    throw new ValidationError("`content` (markdown body) is required.");
  }
  return "content";
}

// Sections inherit account scope from their parent document. Service functions take
// `memexId` and verify the doc belongs to the account before mutating sections (t-9).
export async function addSection(
  memexId: string,
  docId: string,
  sectionType: string,
  content: string,
  title?: string,
  // spec-106 (ac-10): optional free-text section metadata captured at create
  // time. Omitting it leaves the column NULL (the "no description" sentinel).
  description?: string,
  ctx: RequestCtx = {},
): Promise<Mutated<DocSection>> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });

  if (!doc) {
    throw new NotFoundError(`Document ${docId} not found`);
  }

  const sectionTitle =
    title ?? sectionType.charAt(0).toUpperCase() + sectionType.slice(1);

  const section = await mutate(
    ctx,
    { memexId, docId, entity: "section", action: "created" },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(
            docSections,
            docSections.seq,
            docSections.docId,
            docId,
          );
          // spec-150 (dec-2): `seq` is the allocate-once identity; `position` is the
          // display order. A freshly appended section sits last in display order
          // (position == seq only until the two diverge through deletes/splits).
          const position = await nextSeq(
            docSections,
            docSections.position,
            docSections.docId,
            docId,
          );
          try {
            const [row] = await db
              .insert(docSections)
              .values({
                docId,
                sectionType,
                title: sectionTitle,
                ...(description !== undefined ? { description } : {}),
                content,
                seq,
                position,
                // spec-122 dec-2/dec-5 — stamp WHO + HOW at write time (ac-20).
                ...(await resolveActorColumns(ctx)),
              })
              .returning();
            return row;
          } catch (err) {
            // The (docId, sectionType) unique constraint protects against agent retries that
            // try to re-add the same logical section. Surface a readable error so the agent
            // can pick a different sectionType instead of seeing a raw Postgres message.
            // (We let `doc_sections_doc_seq_unique` 23505s bubble up — withSeqRetry handles them.)
            if (
              pgError(err)?.code === "23505" &&
              !isDocSeqConflict(err)
            ) {
              throw new ValidationError(
                `Section type '${sectionType}' already exists on this document. Pick a different identifier (e.g. '${sectionType}-2', or a more specific name).`
              );
            }
            throw err;
          }
        },
        DOC_SECTIONS_SEQ_CONSTRAINT,
      ),
  );

  maybeEmbedSectionInBackground(memexId, section.id);
  return section;
}

/**
 * Split a section at its markdown headings into multiple new sections.
 * The original section keeps the content before the first heading (or becomes the first chunk).
 * New sections are inserted after it, shifting existing seq values to make room.
 */
export async function splitSection(
  memexId: string,
  sectionId: string
): Promise<Mutated<DocSection[]>> {
  // Section ownership is verified through its parent document's account_id.
  const section = await db.query.docSections.findFirst({
    where: eq(docSections.id, sectionId),
  });

  if (!section) {
    throw new NotFoundError(`Section ${sectionId} not found`);
  }

  const parentDoc = await db.query.documents.findFirst({
    where: and(eq(documents.id, section.docId), eq(documents.memexId, memexId)),
  });
  if (!parentDoc) {
    throw new NotFoundError(`Section ${sectionId} not found`);
  }

  const chunks = splitMarkdownByHeadings(section.content);

  if (chunks.length <= 1) {
    throw new ValidationError("Section has no headings to split on");
  }

  const result = await mutate(
    {},
    { memexId, docId: section.docId, entity: "section", action: "updated" },
    async () => {
      // Run in a transaction: shift display positions, update original, insert new
      // sections. spec-150 (dec-2): identity `seq` is never shifted — only the
      // DISPLAY `position` makes room for the new parts.
      return await db.transaction(async (tx) => {
        const slotsNeeded = chunks.length - 1;

        // Shift the display tail after this section to make room for the new parts.
        await tx
          .update(docSections)
          .set({ position: sql`${docSections.position} + ${slotsNeeded}` })
          .where(
            sql`${docSections.docId} = ${section.docId} AND ${docSections.position} > ${section.position}`
          );

        // Update original section with the first chunk
        const [updated] = await tx
          .update(docSections)
          .set({
            content: chunks[0].content,
            title: chunks[0].title ?? section.title,
            updatedAt: new Date(),
          })
          .where(eq(docSections.id, sectionId))
          .returning();

        const allSections: DocSection[] = [updated];

        // Insert new sections for remaining chunks. spec-150 (dec-2): each new part
        // gets an allocate-once identity `seq` (MAX+1, never reused) and a DISPLAY
        // `position` slotted right after the original. The original keeps its `seq`
        // and `position`.
        const [{ maxSeq }] = await tx
          .select({ maxSeq: sql<number>`coalesce(max(${docSections.seq}), 0)` })
          .from(docSections)
          .where(eq(docSections.docId, section.docId));
        for (let i = 1; i < chunks.length; i++) {
          const [newSection] = await tx
            .insert(docSections)
            .values({
              docId: section.docId,
              sectionType: `${section.sectionType}_part_${i + 1}`,
              title: chunks[i].title ?? `${section.title ?? section.sectionType} (Part ${i + 1})`,
              content: chunks[i].content,
              seq: maxSeq + i,
              position: section.position + i,
            })
            .returning();
          allSections.push(newSection);
        }

        return allSections;
      });
    },
  );

  for (const s of result) maybeEmbedSectionInBackground(memexId, s.id);
  return result;
}

interface MarkdownChunk {
  title: string | null;
  content: string;
}

function splitMarkdownByHeadings(content: string): MarkdownChunk[] {
  const lines = content.split("\n");
  const chunks: MarkdownChunk[] = [];
  let currentLines: string[] = [];
  let currentTitle: string | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      // Flush previous chunk if it has content
      const text = currentLines.join("\n").trim();
      if (text || chunks.length > 0) {
        chunks.push({ title: currentTitle, content: text });
      }
      currentTitle = headingMatch[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush final chunk
  const text = currentLines.join("\n").trim();
  if (text || currentTitle) {
    chunks.push({ title: currentTitle, content: text });
  }

  // If the first chunk is empty (content started with a heading), drop it
  if (chunks.length > 0 && !chunks[0].content && !chunks[0].title) {
    chunks.shift();
  }

  return chunks;
}

/**
 * Writable section metadata that update_section can set alongside the body.
 *
 * spec-106 (ac-9, ac-10): the existing free-text `sectionType` machine key and
 * the new `description` are both writable metadata. Each field is optional and
 * "absent" (undefined) means "leave unchanged" — distinct from `description:
 * null`, which deliberately clears it back to the no-description sentinel.
 */
export interface SectionMetadataPatch {
  sectionType?: string;
  description?: string | null;
}

export async function updateSection(
  memexId: string,
  sectionId: string,
  content: string,
  // spec-106: optional metadata written in the same mutation as the body so
  // update_section is the single writable surface for sectionType + description.
  metadata: SectionMetadataPatch = {},
  ctx: RequestCtx = {},
): Promise<Mutated<DocSection>> {
  // Verify section's parent doc belongs to the account before update.
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

  const { sectionType, description } = metadata;

  const updated = await mutate(
    ctx,
    { memexId, docId: section.docId, entity: "section", action: "updated" },
    async () => {
      try {
        const [row] = await db
          .update(docSections)
          .set({
            content,
            // Mirror spec-107's retitle pattern: only touch the key when
            // explicitly supplied so a body-only edit can't accidentally null it.
            ...(sectionType !== undefined ? { sectionType } : {}),
            ...(description !== undefined ? { description } : {}),
            updatedAt: new Date(),
            // spec-122 dec-2/dec-5 — re-attribute on edit (who touched it last).
            ...(await resolveActorColumns(ctx)),
          })
          .where(eq(docSections.id, sectionId))
          .returning();
        return row;
      } catch (err) {
        // (docId, sectionType) unique violation → surface the same readable
        // message addSection/retitleSection use so the agent picks a different
        // identifier instead of seeing a raw Postgres 23505.
        if (pgError(err)?.code === "23505") {
          throw new ValidationError(
            `Section type '${sectionType}' already exists on this document. Pick a different identifier (e.g. '${sectionType}-2', or a more specific name).`,
          );
        }
        throw err;
      }
    },
  );
  // Re-embed unconditionally — matches the existing updateSection contract
  // (content edits always re-embed; a sectionType rekey also shifts the key).
  maybeEmbedSectionInBackground(memexId, updated.id);
  return updated;
}

// Verify a section exists and its parent doc belongs to the account. Returns the
// section row. Mirrors the ownership guard in updateSection — cross-memex access
// surfaces NotFoundError so the caller 404s (never 403) per std-7.
async function loadOwnedSection(
  memexId: string,
  sectionId: string,
): Promise<DocSection> {
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
  return section;
}

/**
 * Retitle a section (spec-107 dec-1). Sets the human-visible `title` and, when
 * `sectionType` is supplied, also rekeys the machine identifier — giving full
 * control over section identity for clean recuts. `content` is left untouched.
 *
 * On a (docId, sectionType) collision the existing readable ValidationError is
 * surfaced (matching addSection), so the agent can pick a different key rather
 * than seeing a raw Postgres 23505. When the key changes the section is
 * re-embedded so search stays current.
 */
export async function retitleSection(
  memexId: string,
  sectionId: string,
  title: string,
  sectionType?: string,
): Promise<Mutated<DocSection>> {
  const section = await loadOwnedSection(memexId, sectionId);

  const rekeying = sectionType !== undefined && sectionType !== section.sectionType;

  const updated = await mutate(
    {},
    { memexId, docId: section.docId, entity: "section", action: "updated" },
    async () => {
      try {
        const [row] = await db
          .update(docSections)
          .set({
            title,
            ...(sectionType !== undefined ? { sectionType } : {}),
            updatedAt: new Date(),
          })
          .where(eq(docSections.id, sectionId))
          .returning();
        return row;
      } catch (err) {
        // (docId, sectionType) unique violation → surface the same readable
        // message addSection uses so the agent picks a different identifier.
        if (pgError(err)?.code === "23505") {
          throw new ValidationError(
            `Section type '${sectionType}' already exists on this document. Pick a different identifier (e.g. '${sectionType}-2', or a more specific name).`,
          );
        }
        throw err;
      }
    },
  );

  // Re-embed only when the key changed — the embedding helper keys off
  // sectionType/content, and a pure title change doesn't shift the vector.
  if (rekeying) maybeEmbedSectionInBackground(memexId, updated.id);
  return updated;
}

/**
 * Soft-delete a section (spec-107 dec-2 + dec-3). Flips `status` to 'deleted',
 * captures the prior status in `previousStatus` (restorable, lossless), and
 * resequences the DISPLAY tail — every section with a higher `position` shifts down
 * by one in the same transaction so the rendered numbering stays contiguous.
 *
 * spec-150 (dec-2): the identity `seq` is FROZEN — never resequenced — so the
 * deleted section's `s-N` ref and every other section's ref stay valid. Only
 * `position` (display order) moves.
 *
 * Emitted as a composite mutation: one bus event per changed section (the deleted
 * one + each repositioned one) so the React UI reflects the delete and every
 * renumber live over SSE. Anchored comments stay with the soft-deleted row (no
 * hard cascade fires); tasks.section_ref is free text and dangles harmlessly.
 */
export async function deleteSection(
  memexId: string,
  sectionId: string,
): Promise<Mutated<DocSection>> {
  const section = await loadOwnedSection(memexId, sectionId);
  if (section.status === "deleted") {
    throw new ValidationError("Section is already deleted");
  }

  // Count the display tail (position-after) so the composite emission carries one
  // key per repositioned section. Excludes already-deleted rows — they don't
  // participate in the live display order.
  const tail = await db
    .select({ id: docSections.id })
    .from(docSections)
    .where(
      sql`${docSections.docId} = ${section.docId}
        AND ${docSections.position} > ${section.position}
        AND ${docSections.status} <> 'deleted'`,
    );

  const keys = [
    { memexId, docId: section.docId, entity: "section" as const, action: "deleted" as const },
    ...tail.map(() => ({
      memexId,
      docId: section.docId,
      entity: "section" as const,
      action: "updated" as const,
    })),
  ];

  return mutate(
    {},
    keys,
    async () =>
      db.transaction(async (tx) => {
        // Capture-then-flip: previousStatus records the status held at delete so
        // restoreSection can return the section to it without the caller
        // remembering. Other fields are preserved — restore must be lossless.
        const [deleted] = await tx
          .update(docSections)
          .set({
            status: "deleted",
            previousStatus: section.status,
            updatedAt: new Date(),
          })
          .where(eq(docSections.id, sectionId))
          .returning();

        // spec-150 (dec-2): `seq` (identity) is FROZEN. Only the DISPLAY order
        // shifts — bump the live tail's `position` down by one so the rendered
        // numbering stays contiguous (the behaviour spec-107 gave `seq`, now on
        // `position`). Skip deleted rows.
        await tx
          .update(docSections)
          .set({ position: sql`${docSections.position} - 1` })
          .where(
            sql`${docSections.docId} = ${section.docId}
              AND ${docSections.position} > ${section.position}
              AND ${docSections.status} <> 'deleted'`,
          );

        return deleted;
      }),
  );
}

/**
 * Restore a soft-deleted section to the status it held before delete (spec-107
 * dec-2). The identity `seq` is unchanged (the restored section keeps its `s-N`
 * ref). spec-150 (dec-2): its old DISPLAY `position` was reclaimed when the tail
 * shifted down at delete, so restore re-appends it to the end of the display order
 * (MAX(position)+1) rather than colliding with a live slot.
 */
export async function restoreSection(
  memexId: string,
  sectionId: string,
): Promise<Mutated<DocSection>> {
  const section = await loadOwnedSection(memexId, sectionId);
  if (section.status !== "deleted") {
    throw new ValidationError(
      `Only deleted sections can be restored (current status: ${section.status})`,
    );
  }

  const restored = await mutate(
    {},
    { memexId, docId: section.docId, entity: "section", action: "updated" },
    async () => {
      // Re-append to the display order; identity `seq` stays put.
      const position = await nextSeq(
        docSections,
        docSections.position,
        docSections.docId,
        section.docId,
      );
      const [row] = await db
        .update(docSections)
        .set({
          // previousStatus captured the live status at delete; default to
          // 'active' if a legacy delete left it null.
          status: section.previousStatus ?? "active",
          previousStatus: null,
          position,
          updatedAt: new Date(),
        })
        .where(eq(docSections.id, sectionId))
        .returning();
      return row;
    },
  );
  maybeEmbedSectionInBackground(memexId, restored.id);
  return restored;
}
