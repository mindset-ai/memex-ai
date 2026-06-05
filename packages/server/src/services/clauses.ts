// spec-150 t-3: the standard-clause service.
//
// Clauses are first-class rows (dec-1) addressed `std-N/clauses/cl-N`. A section is
// either NOT decomposed (preamble = null, `content` authoritative, no clauses) or
// decomposed (preamble set + ordered clause rows; `content` is the derived
// byte-identical projection of preamble + clauses, maintained here).
//
// std-8: every write goes through mutate() returning Mutated<T>. A clause write also
// regenerates its section's content, so each op emits a COMPOSITE — one `clause`
// event for the clause change plus one `section` updated event for the regenerated
// content (per the composite-mutation rule, one event per logical change).
//
// Identity vs order (dec-2): `seq` is the allocate-once per-standard `cl-N` handle,
// minted as MAX(seq)+1 and NEVER resequenced (delete is a soft-delete; a freed seq is
// never reused). `position` orders clauses within their section for composition; it
// may move freely and is not the identity.

import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, standardClauses } from "../db/schema.js";
import type { DocSection, StandardClause } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { composeSectionContent, splitSectionIntoClauses } from "./clause-composition.js";
import { embedAndStoreSection } from "./memex-embeddings.js";

const CLAUSE_SEQ_CONSTRAINT = "standard_clauses_doc_seq_unique";

// A drizzle transaction handle (same query surface as `db`). Kept loose to avoid
// pinning the generic; the methods we use (select/insert/update) are identical.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Content changed → refresh the section's embedding off the request path (best-effort,
// mirrors sections.ts). No provider in tests → it no-ops.
function reembedInBackground(memexId: string, sectionId: string): void {
  void embedAndStoreSection(sectionId, { memexId }).catch(() => {});
}

async function loadOwnedSection(memexId: string, sectionId: string): Promise<DocSection> {
  const section = await db.query.docSections.findFirst({
    where: eq(docSections.id, sectionId),
  });
  if (!section) throw new NotFoundError(`Section ${sectionId} not found`);
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, section.docId), eq(documents.memexId, memexId)),
  });
  if (!doc) throw new NotFoundError(`Section ${sectionId} not found`);
  return section;
}

async function loadOwnedClause(memexId: string, clauseId: string): Promise<StandardClause> {
  const clause = await db.query.standardClauses.findFirst({
    where: and(eq(standardClauses.id, clauseId), eq(standardClauses.memexId, memexId)),
  });
  if (!clause) throw new NotFoundError(`Clause ${clauseId} not found`);
  return clause;
}

async function liveClausesForSection(tx: Tx, sectionId: string): Promise<StandardClause[]> {
  return tx
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.sectionId, sectionId), ne(standardClauses.status, "deleted")))
    .orderBy(asc(standardClauses.position));
}

async function maxClauseSeqTx(tx: Tx, docId: string): Promise<number> {
  const [r] = await tx
    .select({ m: sql<number>`coalesce(max(${standardClauses.seq}), 0)` })
    .from(standardClauses)
    .where(eq(standardClauses.docId, docId));
  return r?.m ?? 0;
}

async function maxPositionTx(tx: Tx, sectionId: string): Promise<number> {
  const [r] = await tx
    .select({ m: sql<number>`coalesce(max(${standardClauses.position}), 0)` })
    .from(standardClauses)
    .where(eq(standardClauses.sectionId, sectionId));
  return r?.m ?? 0;
}

// Recompute and persist the section's derived content from its preamble + live
// clauses, inside the caller's transaction. Returns the new content.
async function regenerateSectionContentTx(tx: Tx, section: DocSection): Promise<string> {
  const clauses = await liveClausesForSection(tx, section.id);
  // spec-161: a clause-first section (preamble null) IS its clauses — content is their
  // ordered join (dec-7). A legacy decomposed section (preamble set, the spec-150
  // transparent substrate) recomposes byte-identically from preamble + clauses.
  const content =
    section.preamble !== null
      ? composeSectionContent(
          section.preamble,
          clauses.map((c) => ({ position: c.position, body: c.body })),
        )
      : clauses.map((c) => c.body).join("\n\n");
  await tx
    .update(docSections)
    .set({ content, updatedAt: new Date() })
    .where(eq(docSections.id, section.id));
  return content;
}

export interface DecomposedSection {
  section: DocSection;
  clauses: StandardClause[];
}

/**
 * Decompose a not-yet-decomposed section: split its content into a preamble + clause
 * rows. `content` is left unchanged — `compose(split(content)) === content` — so every
 * downstream reader sees the same bytes (the transparency contract). A section with no
 * list items gets `preamble = content` and zero clauses (a no-op decomposition).
 */
export async function decomposeSection(
  memexId: string,
  sectionId: string,
): Promise<Mutated<DecomposedSection>> {
  const section = await loadOwnedSection(memexId, sectionId);
  if (section.preamble !== null) {
    throw new ValidationError("Section is already decomposed");
  }
  const { preamble, clauses: bodies } = splitSectionIntoClauses(section.content);

  const keys = [
    { memexId, docId: section.docId, entity: "section" as const, action: "updated" as const },
    ...bodies.map(() => ({
      memexId,
      docId: section.docId,
      entity: "clause" as const,
      action: "created" as const,
    })),
  ];

  return mutate({}, keys, async () =>
    db.transaction(async (tx) => {
      await tx
        .update(docSections)
        .set({ preamble, updatedAt: new Date() })
        .where(eq(docSections.id, sectionId));

      const startSeq = (await maxClauseSeqTx(tx, section.docId)) + 1;
      const created: StandardClause[] = [];
      for (let i = 0; i < bodies.length; i++) {
        const [row] = await tx
          .insert(standardClauses)
          .values({
            memexId,
            docId: section.docId,
            sectionId,
            seq: startSeq + i,
            position: i + 1,
            body: bodies[i],
          })
          .returning();
        created.push(row);
      }
      // content is unchanged by construction; no regenerate needed.
      return { section: { ...section, preamble }, clauses: created };
    }),
  );
}

/** Append (or insert at `position`) a clause to a decomposed section; regenerate content. */
export async function createClause(
  memexId: string,
  sectionId: string,
  body: string,
  position?: number,
): Promise<Mutated<StandardClause>> {
  // spec-161: clauses are created directly on clause-first standard sections (preamble
  // null), so there is no "decompose first" precondition. Legacy decomposed sections
  // (preamble set) accept clauses too; regenerate handles both shapes.
  const section = await loadOwnedSection(memexId, sectionId);

  const keys = [
    { memexId, docId: section.docId, entity: "clause" as const, action: "created" as const },
    { memexId, docId: section.docId, entity: "section" as const, action: "updated" as const },
  ];

  return mutate({}, keys, async () =>
    db.transaction(async (tx) => {
      const seq = (await maxClauseSeqTx(tx, section.docId)) + 1;
      const pos = position ?? (await maxPositionTx(tx, sectionId)) + 1;
      const [row] = await tx
        .insert(standardClauses)
        .values({ memexId, docId: section.docId, sectionId, seq, position: pos, body })
        .returning();
      await regenerateSectionContentTx(tx, section);
      return row;
    }),
  ).then((row) => {
    reembedInBackground(memexId, sectionId);
    return row;
  });
}

/**
 * Append a batch of clauses to a section in one transaction, then regenerate content.
 * Used when a standard section is authored clause-first (add_section with clauses[]):
 * one section-created event has already fired; this emits one clause-created per body
 * plus the section-updated for the regenerated content. Allocate-once seqs (MAX+1 per
 * doc), positions appended after any existing clauses.
 */
export async function addClausesToSection(
  memexId: string,
  sectionId: string,
  bodies: string[],
): Promise<Mutated<StandardClause[]>> {
  const section = await loadOwnedSection(memexId, sectionId);
  const clean = bodies.map((b) => b ?? "").filter((b) => b.trim().length > 0);
  if (clean.length === 0) {
    throw new ValidationError("At least one non-empty clause is required.");
  }

  const keys = [
    ...clean.map(() => ({
      memexId,
      docId: section.docId,
      entity: "clause" as const,
      action: "created" as const,
    })),
    { memexId, docId: section.docId, entity: "section" as const, action: "updated" as const },
  ];

  const created = await mutate({}, keys, async () =>
    db.transaction(async (tx) => {
      let seq = await maxClauseSeqTx(tx, section.docId);
      let pos = await maxPositionTx(tx, sectionId);
      const rows: StandardClause[] = [];
      for (const body of clean) {
        seq++;
        pos++;
        const [row] = await tx
          .insert(standardClauses)
          .values({ memexId, docId: section.docId, sectionId, seq, position: pos, body })
          .returning();
        rows.push(row);
      }
      await regenerateSectionContentTx(tx, section);
      return rows;
    }),
  );
  reembedInBackground(memexId, sectionId);
  return created;
}

/** Edit a clause's body; regenerate the section's derived content. */
export async function updateClause(
  memexId: string,
  clauseId: string,
  body: string,
): Promise<Mutated<StandardClause>> {
  const clause = await loadOwnedClause(memexId, clauseId);
  const section = await loadOwnedSection(memexId, clause.sectionId);

  const keys = [
    { memexId, docId: clause.docId, entity: "clause" as const, action: "updated" as const },
    { memexId, docId: clause.docId, entity: "section" as const, action: "updated" as const },
  ];

  return mutate({}, keys, async () =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .update(standardClauses)
        .set({ body, updatedAt: new Date() })
        .where(eq(standardClauses.id, clauseId))
        .returning();
      await regenerateSectionContentTx(tx, section);
      return row;
    }),
  ).then((row) => {
    reembedInBackground(memexId, section.id);
    return row;
  });
}

/**
 * Soft-delete a clause (status → 'deleted'); regenerate content (the clause drops out).
 * NO resequencing (dec-2): the deleted seq is frozen and every other clause's `cl-N`
 * handle is untouched; gaps are tolerated.
 */
export async function deleteClause(
  memexId: string,
  clauseId: string,
): Promise<Mutated<StandardClause>> {
  const clause = await loadOwnedClause(memexId, clauseId);
  if (clause.status === "deleted") {
    throw new ValidationError("Clause is already deleted");
  }
  const section = await loadOwnedSection(memexId, clause.sectionId);

  const keys = [
    { memexId, docId: clause.docId, entity: "clause" as const, action: "deleted" as const },
    { memexId, docId: clause.docId, entity: "section" as const, action: "updated" as const },
  ];

  return mutate({}, keys, async () =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .update(standardClauses)
        .set({ status: "deleted", previousStatus: clause.status, updatedAt: new Date() })
        .where(eq(standardClauses.id, clauseId))
        .returning();
      await regenerateSectionContentTx(tx, section);
      return row;
    }),
  ).then((row) => {
    reembedInBackground(memexId, section.id);
    return row;
  });
}
