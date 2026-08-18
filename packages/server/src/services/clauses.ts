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

import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, standardClauses } from "../db/schema.js";
import type { DocSection, StandardClause } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { resolveActorColumns } from "./actor.js";
import { composeSectionContent, splitSectionIntoClauses } from "./clause-composition.js";
import { embedAndStoreSection } from "./memex-embeddings.js";
import { syncClauseRefsTx } from "./clause-refs.js";
import { validateClauseFacetsBatch, persistClauseFacets } from "./facet-vocab.js";

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

// spec-530 dec-5 (ac-23): `position` THEN `seq`. Ordering by position alone left tied
// rows to scan order, so a section's composed content was not a function of its rows —
// two regenerations with no write in between could differ. dec-5's shift prevents NEW
// ties; this tiebreaker is what makes the rows already tied in a production database
// compose deterministically, which no insert-side fix can reach. `seq` is allocate-once,
// unique per doc and never resequenced (spec-150 dec-2), so the order is total.
async function liveClausesForSection(tx: Tx, sectionId: string): Promise<StandardClause[]> {
  return tx
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.sectionId, sectionId), ne(standardClauses.status, "deleted")))
    .orderBy(asc(standardClauses.position), asc(standardClauses.seq));
}

/**
 * Make room at `fromPosition` by pushing every LIVE sibling at or after it down one.
 *
 * spec-530 dec-5 (issue-1, ac-23). Inserting at an occupied ordinal used to simply write
 * the duplicate, and `add_clause`'s optional `position` makes that reachable by any
 * caller. t-4's anchor→ordinal translation hits it on every `add` by construction, since
 * "insert before cl-N" resolves to an ordinal that is by definition already taken.
 *
 * Soft-deleted rows are excluded, matching liveClausesForSection's filter: a deleted
 * clause has no place in the order and must not consume an ordinal.
 */
async function shiftPositionsFromTx(
  tx: Tx,
  sectionId: string,
  fromPosition: number,
): Promise<void> {
  await tx
    .update(standardClauses)
    .set({ position: sql`${standardClauses.position} + 1` })
    .where(
      and(
        eq(standardClauses.sectionId, sectionId),
        ne(standardClauses.status, "deleted"),
        gte(standardClauses.position, fromPosition),
      ),
    );
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

// spec-530 t-3 — the section row a clause write regenerates is activity-bearing
// [per std-32 cl-9], so it carries WHO + HOW like any other write to it. Resolved
// ONCE by the caller before its transaction opens (resolveActorColumns does an
// indexed users lookup) and passed in, so the tx stays free of a round trip.
type ActorColumns = Awaited<ReturnType<typeof resolveActorColumns>>;

// Recompute and persist the section's derived content from its preamble + live
// clauses, inside the caller's transaction. Returns the new content.
async function regenerateSectionContentTx(
  tx: Tx,
  section: DocSection,
  actor: ActorColumns,
): Promise<string> {
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
    .set({
      content,
      updatedAt: new Date(),
      // Re-attribute on edit — who touched it last. Same semantics as
      // updateSection (sections.ts), which this path is the clause-grained
      // sibling of: editing a clause IS editing the section's text.
      ...actor,
    })
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
  ctx: RequestCtx = {},
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

  const actor = await resolveActorColumns(ctx);

  return mutate(ctx, keys, async () =>
    db.transaction(async (tx) => {
      await tx
        .update(docSections)
        .set({ preamble, updatedAt: new Date(), ...actor })
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
        await syncClauseRefsTx(tx, row); // spec-179: materialize handle mentions
        created.push(row);
      }
      // content is unchanged by construction; no regenerate needed.
      return { section: { ...section, preamble }, clauses: created };
    }),
  );
}

// ── Transaction-level primitives ──────────────────────
//
// spec-530 t-4: `accept_standard_change` applies a SET of clause operations and resolves
// the proposal in ONE transaction (dec-4's atomicity property). The public verbs below
// each open their own `db.transaction`, so calling them in a loop would give N
// transactions and a Standard that can be left half-rewritten — the exact state ac-10
// forbids. These primitives are the composable core: they take the caller's `tx`, do no
// regeneration and no emitting, and leave both to whoever owns the transaction.
//
// The public verbs are thin wrappers over them, so there is one implementation of each
// write rather than a second copy living in the accept path.

/** Insert one clause inside the caller's transaction. Allocates the doc-wide `seq`
 *  (MAX+1, allocate-once), and for a supplied `position` shifts live siblings out of the
 *  way first [per dec-5] so ordinals stay unique and dense. No position → append. */
export async function insertClauseTx(
  tx: Tx,
  memexId: string,
  section: Pick<DocSection, "id" | "docId">,
  body: string,
  position?: number,
): Promise<StandardClause> {
  const seq = (await maxClauseSeqTx(tx, section.docId)) + 1;
  let pos: number;
  if (position === undefined) {
    pos = (await maxPositionTx(tx, section.id)) + 1;
  } else {
    pos = position;
    await shiftPositionsFromTx(tx, section.id, pos);
  }
  const [row] = await tx
    .insert(standardClauses)
    .values({ memexId, docId: section.docId, sectionId: section.id, seq, position: pos, body })
    .returning();
  await syncClauseRefsTx(tx, row); // spec-179: materialize handle mentions
  return row;
}

/** Replace one clause's body inside the caller's transaction. */
export async function updateClauseBodyTx(
  tx: Tx,
  clauseId: string,
  body: string,
): Promise<StandardClause> {
  const [row] = await tx
    .update(standardClauses)
    .set({ body, updatedAt: new Date() })
    .where(eq(standardClauses.id, clauseId))
    .returning();
  await syncClauseRefsTx(tx, row); // spec-179: re-derive handle mentions
  return row;
}

/** Soft-delete one clause inside the caller's transaction. No resequencing (spec-150
 *  dec-2): the freed `seq` is frozen and every other `cl-N` handle is untouched. */
export async function softDeleteClauseTx(
  tx: Tx,
  clause: StandardClause,
): Promise<StandardClause> {
  const [row] = await tx
    .update(standardClauses)
    .set({ status: "deleted", previousStatus: clause.status, updatedAt: new Date() })
    .where(eq(standardClauses.id, clause.id))
    .returning();
  await syncClauseRefsTx(tx, row); // spec-179: soft-deleted clause keeps zero refs
  return row;
}

export { regenerateSectionContentTx, liveClausesForSection };
export type { Tx };

// ── Public verbs ──────────────────────────────────────

/** Append (or insert at `position`) a clause to a decomposed section; regenerate content. */
export async function createClause(
  memexId: string,
  sectionId: string,
  body: string,
  position?: number,
  ctx: RequestCtx = {},
): Promise<Mutated<StandardClause>> {
  // spec-161: clauses are created directly on clause-first standard sections (preamble
  // null), so there is no "decompose first" precondition. Legacy decomposed sections
  // (preamble set) accept clauses too; regenerate handles both shapes.
  const section = await loadOwnedSection(memexId, sectionId);

  const keys = [
    { memexId, docId: section.docId, entity: "clause" as const, action: "created" as const },
    { memexId, docId: section.docId, entity: "section" as const, action: "updated" as const },
  ];

  const actor = await resolveActorColumns(ctx);

  return mutate(ctx, keys, async () =>
    db.transaction(async (tx) => {
      const row = await insertClauseTx(tx, memexId, section, body, position);
      await regenerateSectionContentTx(tx, section, actor);
      return row;
    }),
  ).then((row) => {
    reembedInBackground(memexId, sectionId);
    return row;
  });
}

/** One clause for the bulk authoring path: its body plus its facet verdict (spec-437
 *  dec-1). `facets` is the deliberate verdict — facet keys, or [] for "governs nothing".
 *  Where the Memex has a vocabulary it is REQUIRED; an absent (undefined) verdict is
 *  rejected, exactly as add_clause enforces on the single-clause path. */
export interface BulkClauseInput {
  body: string;
  facets: string[] | undefined;
}

/**
 * Append a batch of clauses to a section in one transaction, then regenerate content.
 * Used when a standard section is authored clause-first (add_section with clauses[]):
 * one section-created event has already fired; this emits one clause-created per body
 * plus the section-updated for the regenerated content. Allocate-once seqs (MAX+1 per
 * doc), positions appended after any existing clauses.
 *
 * spec-437 dec-1: every clause carries a facet verdict, validated BEFORE any row is
 * created (so a rejected verdict leaves no orphan clauses) and persisted after — closing
 * the bulk-path hole that let add_section / the seeder mint ballotless clauses.
 */
export async function addClausesToSection(
  memexId: string,
  sectionId: string,
  clauses: BulkClauseInput[],
  ctx: RequestCtx = {},
): Promise<Mutated<StandardClause[]>> {
  const section = await loadOwnedSection(memexId, sectionId);
  const clean = clauses.filter((c) => (c.body ?? "").trim().length > 0);
  if (clean.length === 0) {
    throw new ValidationError("At least one non-empty clause is required.");
  }

  // spec-437 dec-1: validate every verdict up front, with ONE vocab load (not one query
  // per clause). Throws on an absent-where-required or unknown-key verdict; returns
  // null-per-clause when the Memex has no vocabulary (no verdict required, nothing to
  // persist).
  const facetIdsPerClause = await validateClauseFacetsBatch(
    memexId,
    clean.map((c) => c.facets),
  );

  const keys = [
    ...clean.map(() => ({
      memexId,
      docId: section.docId,
      entity: "clause" as const,
      action: "created" as const,
    })),
    { memexId, docId: section.docId, entity: "section" as const, action: "updated" as const },
  ];

  const actor = await resolveActorColumns(ctx);

  const created = await mutate(ctx, keys, async () =>
    db.transaction(async (tx) => {
      let seq = await maxClauseSeqTx(tx, section.docId);
      let pos = await maxPositionTx(tx, sectionId);
      const rows: StandardClause[] = [];
      for (const c of clean) {
        seq++;
        pos++;
        const [row] = await tx
          .insert(standardClauses)
          .values({ memexId, docId: section.docId, sectionId, seq, position: pos, body: c.body })
          .returning();
        await syncClauseRefsTx(tx, row); // spec-179: materialize handle mentions
        rows.push(row);
      }
      await regenerateSectionContentTx(tx, section, actor);
      return rows;
    }),
  );

  // Persist each clause's verdict (replace semantics; [] → the governs-nothing marker).
  // Skipped only where the Memex has no vocabulary (facetIds === null).
  for (let i = 0; i < created.length; i++) {
    const facetIds = facetIdsPerClause[i];
    if (facetIds !== null) {
      await persistClauseFacets(memexId, section.docId, created[i].id, facetIds, ctx);
    }
  }

  reembedInBackground(memexId, sectionId);
  return created;
}

/** Edit a clause's body; regenerate the section's derived content. */
export async function updateClause(
  memexId: string,
  clauseId: string,
  body: string,
  ctx: RequestCtx = {},
): Promise<Mutated<StandardClause>> {
  const clause = await loadOwnedClause(memexId, clauseId);
  const section = await loadOwnedSection(memexId, clause.sectionId);

  const keys = [
    { memexId, docId: clause.docId, entity: "clause" as const, action: "updated" as const },
    { memexId, docId: clause.docId, entity: "section" as const, action: "updated" as const },
  ];

  const actor = await resolveActorColumns(ctx);

  return mutate(ctx, keys, async () =>
    db.transaction(async (tx) => {
      const row = await updateClauseBodyTx(tx, clauseId, body);
      await regenerateSectionContentTx(tx, section, actor);
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
  ctx: RequestCtx = {},
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

  const actor = await resolveActorColumns(ctx);

  return mutate(ctx, keys, async () =>
    db.transaction(async (tx) => {
      const row = await softDeleteClauseTx(tx, clause);
      await regenerateSectionContentTx(tx, section, actor);
      return row;
    }),
  ).then((row) => {
    reembedInBackground(memexId, section.id);
    return row;
  });
}
