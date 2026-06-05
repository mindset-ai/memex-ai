// spec-150 t-6: decompose every standard's sections into clauses via the LLM
// translator.
//
// This is the single transformative step of spec-150. It walks every not-yet-
// decomposed standard section (one with no clauses) and translates its content into
// one-aspect clause rows (dec-7: meaning-preserving reword, NOT byte-identical). The
// section's `content` is replaced by the ordered concatenation of its clauses
// (`clauses.join("\n\n")`) and `preamble` is nulled — the partition invariant: a
// section IS exactly its clauses, in order.
//
// Wrapped in the dec-4 safety protocol: snapshot first (content + preamble), validate
// the partition invariant after (content === join of clauses; no empty sections), with
// a restore path to roll back. The translator is injectable so tests run the full
// protocol deterministically and key-free.
//
// Functions are scopeable by memexId so tests exercise the protocol on a seeded
// standard without touching the real corpus; the migration script runs them unscoped.

import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, standardClauses } from "../db/schema.js";
import { translateSectionToClauses } from "./clause-translator.js";

const STANDARD_DOC_TYPE = "standard";

// Decompose docs concurrently, but sections WITHIN a doc sequentially: clause `seq` is
// allocated as MAX(seq)+1 per doc, so two sections of the same doc must not race it.
// Different docs never collide (the unique constraint is on (doc_id, seq)).
const DOC_CONCURRENCY = 6;

/** A section to (re)decompose: its content plus the ids needed to persist clauses. */
interface PendingSection {
  sectionId: string;
  docId: string;
  memexId: string;
  content: string;
}

/** Standard sections that have no live clauses yet (optionally scoped to one memex). */
async function pendingStandardSections(memexId?: string): Promise<PendingSection[]> {
  const sections = await db
    .select({
      sectionId: docSections.id,
      docId: docSections.docId,
      memexId: documents.memexId,
      content: docSections.content,
    })
    .from(docSections)
    .innerJoin(documents, eq(docSections.docId, documents.id))
    .where(
      and(
        eq(documents.docType, STANDARD_DOC_TYPE),
        ne(docSections.status, "deleted"),
        ...(memexId ? [eq(documents.memexId, memexId)] : []),
      ),
    );

  const withClauses = await db
    .selectDistinct({ sectionId: standardClauses.sectionId })
    .from(standardClauses)
    .where(ne(standardClauses.status, "deleted"));
  const done = new Set(withClauses.map((r) => r.sectionId));

  return sections.filter((s) => !done.has(s.sectionId));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Translate with bounded retry + backoff. A single transient LLM error (rate limit,
 * 529 overloaded, a dropped socket) must not abort a whole-corpus migration — and the
 * thrown message is a plain string so the operator's error log can't choke on an SDK
 * error object that embeds a Headers (the Node/undici inspect crash). The migration is
 * resumable regardless: a re-run skips sections that already have clauses.
 */
async function translateWithRetry(
  content: string,
  translate: TranslateFn,
  label: string,
  attempts = 4,
): Promise<string[]> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await translate(content);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(1000 * 3 ** i); // 1s, 3s, 9s
    }
  }
  const msg = (lastErr as { message?: string })?.message ?? String(lastErr);
  throw new Error(`clause translation failed for ${label} after ${attempts} attempts: ${msg}`);
}

/** Translate one section and persist its clauses + content=join + preamble=null. */
async function decomposeOneSection(
  section: PendingSection,
  translate: TranslateFn,
): Promise<number> {
  const clauses = await translateWithRetry(section.content, translate, `section ${section.sectionId}`);
  await db.transaction(async (tx) => {
    const [{ m }] = await tx
      .select({ m: sql<number>`coalesce(max(${standardClauses.seq}), 0)` })
      .from(standardClauses)
      .where(eq(standardClauses.docId, section.docId));
    let seq = m ?? 0;
    for (let i = 0; i < clauses.length; i++) {
      seq++;
      await tx.insert(standardClauses).values({
        memexId: section.memexId,
        docId: section.docId,
        sectionId: section.sectionId,
        seq,
        position: i + 1,
        body: clauses[i],
      });
    }
    await tx
      .update(docSections)
      .set({ content: clauses.join("\n\n"), preamble: null, updatedAt: new Date() })
      .where(eq(docSections.id, section.sectionId));
  });
  return clauses.length;
}

export type TranslateFn = (content: string) => Promise<string[]>;

export interface DecomposeReport {
  sectionsDecomposed: number;
  clausesCreated: number;
}

/**
 * Decompose every not-yet-decomposed standard section (optionally scoped to one memex).
 * `translate` defaults to the live LLM translator; inject a deterministic fn in tests.
 */
export async function decomposeAllStandards(
  opts: { memexId?: string; translate?: TranslateFn } = {},
): Promise<DecomposeReport> {
  const translate = opts.translate ?? translateSectionToClauses;
  const pending = await pendingStandardSections(opts.memexId);

  // Group by doc; run docs in bounded-concurrency batches, sections within a doc serial.
  const byDoc = new Map<string, PendingSection[]>();
  for (const s of pending) {
    byDoc.set(s.docId, [...(byDoc.get(s.docId) ?? []), s]);
  }
  const docGroups = [...byDoc.values()];

  let clausesCreated = 0;
  for (let i = 0; i < docGroups.length; i += DOC_CONCURRENCY) {
    const batch = docGroups.slice(i, i + DOC_CONCURRENCY);
    const counts = await Promise.all(
      batch.map(async (group) => {
        let n = 0;
        for (const section of group) n += await decomposeOneSection(section, translate);
        return n;
      }),
    );
    clausesCreated += counts.reduce((a, b) => a + b, 0);
  }
  return { sectionsDecomposed: pending.length, clausesCreated };
}

// ── dec-4 safety protocol: backup / validate / restore ───────────────────────
// A snapshot table captures every standard section's pre-migration content +
// preamble. It must be taken BEFORE decomposeAllStandards runs.

export async function backupStandards(): Promise<number> {
  await db.execute(sql`DROP TABLE IF EXISTS doc_sections_spec150_backup`);
  await db.execute(sql`
    CREATE TABLE doc_sections_spec150_backup AS
    SELECT s.id, s.content, s.preamble
    FROM doc_sections s
    INNER JOIN documents d ON d.id = s.doc_id
    WHERE d.doc_type = ${STANDARD_DOC_TYPE}
  `);
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM doc_sections_spec150_backup`,
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

export async function dropBackup(): Promise<void> {
  await db.execute(sql`DROP TABLE IF EXISTS doc_sections_spec150_backup`);
}

export interface PartitionReport {
  /** Sections that have at least one live clause (the decomposed set). */
  checked: number;
  /** Section ids where content !== the ordered join of live clauses (invariant break). */
  contentMismatch: string[];
  /** Standard sections left with zero live clauses (decomposition produced nothing). */
  emptySections: string[];
}

/**
 * The post-migration invariant (dec-7): every decomposed section's `content` equals the
 * `\n\n`-join of its live clauses ordered by position, and no standard section is left
 * clause-less. Replaces the old byte-identity check (content now legitimately changes).
 */
export async function validateClausePartition(
  opts: { memexId?: string } = {},
): Promise<PartitionReport> {
  const scope = opts.memexId ? sql`AND d.memex_id = ${opts.memexId}` : sql``;

  const mismatch = (await db.execute(sql`
    SELECT s.id::text AS id
    FROM doc_sections s
    INNER JOIN documents d ON d.id = s.doc_id
    WHERE d.doc_type = ${STANDARD_DOC_TYPE}
      AND s.status <> 'deleted'
      ${scope}
      AND EXISTS (
        SELECT 1 FROM standard_clauses c
        WHERE c.section_id = s.id AND c.status <> 'deleted'
      )
      AND s.content IS DISTINCT FROM (
        SELECT string_agg(c.body, E'\n\n' ORDER BY c.position)
        FROM standard_clauses c
        WHERE c.section_id = s.id AND c.status <> 'deleted'
      )
  `)) as unknown as { id: string }[];

  const empty = (await db.execute(sql`
    SELECT s.id::text AS id
    FROM doc_sections s
    INNER JOIN documents d ON d.id = s.doc_id
    WHERE d.doc_type = ${STANDARD_DOC_TYPE}
      AND s.status <> 'deleted'
      ${scope}
      AND NOT EXISTS (
        SELECT 1 FROM standard_clauses c
        WHERE c.section_id = s.id AND c.status <> 'deleted'
      )
  `)) as unknown as { id: string }[];

  const checkedRows = (await db.execute(sql`
    SELECT count(DISTINCT c.section_id)::int AS n
    FROM standard_clauses c
    INNER JOIN documents d ON d.id = c.doc_id
    WHERE d.doc_type = ${STANDARD_DOC_TYPE} AND c.status <> 'deleted' ${scope}
  `)) as unknown as { n: number }[];

  return {
    checked: checkedRows[0]?.n ?? 0,
    contentMismatch: mismatch.map((r) => r.id),
    emptySections: empty.map((r) => r.id),
  };
}

/** Roll back: restore content + preamble from the snapshot and drop the clauses
 * decomposition created (scopeable by memex for isolated tests). */
export async function restoreStandardsFromBackup(
  opts: { memexId?: string } = {},
): Promise<void> {
  await db.execute(sql`
    UPDATE doc_sections s
    SET content = b.content, preamble = b.preamble
    FROM doc_sections_spec150_backup b, documents d
    WHERE b.id = s.id
      AND s.doc_id = d.id
      AND d.doc_type = ${STANDARD_DOC_TYPE}
      ${opts.memexId ? sql`AND d.memex_id = ${opts.memexId}` : sql``}
  `);
  await db.execute(sql`
    DELETE FROM standard_clauses c
    USING documents d
    WHERE c.doc_id = d.id
      AND d.doc_type = ${STANDARD_DOC_TYPE}
      ${opts.memexId ? sql`AND d.memex_id = ${opts.memexId}` : sql``}
  `);
}
