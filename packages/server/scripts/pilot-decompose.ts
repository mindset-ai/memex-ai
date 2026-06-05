// spec-150 dec-6/dec-7: N==1 pilot. Decompose ONE standard via the LLM translator,
// persisting clauses + content=join, behind a per-standard backup (reversible).
// Prints BEFORE (original section content) vs AFTER (the clauses) for assessment.
//
//   pnpm exec tsx scripts/pilot-decompose.ts [std-handle]   (default std-17)
//   pnpm exec tsx scripts/pilot-decompose.ts --restore      (undo the pilot)
import "dotenv/config";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db } from "../src/db/connection.js";
import { documents, docSections, standardClauses } from "../src/db/schema.js";
import { translateSectionToClauses } from "../src/services/clause-translator.js";

const BACKUP = "pilot_decompose_backup";

async function restore(): Promise<void> {
  await db.execute(sql`
    UPDATE doc_sections s SET content = b.content, preamble = b.preamble
    FROM pilot_decompose_backup b WHERE b.id = s.id
  `);
  await db.execute(sql`
    DELETE FROM standard_clauses c USING pilot_decompose_backup b WHERE c.section_id = b.id
  `);
  // eslint-disable-next-line no-console
  console.log("[pilot] restored from backup; clauses deleted.");
}

async function main(): Promise<void> {
  if (process.argv.includes("--restore")) return restore();
  const handle = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "std-17";

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.docType, "standard"), eq(documents.handle, handle)),
  });
  if (!doc) throw new Error(`standard ${handle} not found`);

  const sections = await db
    .select()
    .from(docSections)
    .where(and(eq(docSections.docId, doc.id), ne(docSections.status, "deleted")))
    .orderBy(asc(docSections.seq));

  // Per-standard backup (content + preamble) so the pilot is reversible.
  await db.execute(sql`DROP TABLE IF EXISTS pilot_decompose_backup`);
  await db.execute(sql`
    CREATE TABLE pilot_decompose_backup AS
    SELECT id, content, preamble FROM doc_sections WHERE doc_id = ${doc.id}
  `);

  const log = (...a: unknown[]) => console.log(...a); // eslint-disable-line no-console
  log(`\n================ ${handle} "${doc.title}" — ${sections.length} sections ================`);

  for (const s of sections) {
    log(`\n\n######## SECTION s-${s.seq}: ${s.title ?? s.sectionType} (${s.content.length} chars) ########`);
    log("\n----- BEFORE (original) -----\n" + s.content);

    const clauses = await translateSectionToClauses(s.content);

    log(`\n----- AFTER (${clauses.length} clauses) -----`);
    clauses.forEach((c, i) => log(`  [cl ${i + 1}] ${c}`));

    // Persist: allocate-once clause seq per doc, position 1..N, content = join.
    await db.transaction(async (tx) => {
      const [{ m }] = (await tx
        .select({ m: sql<number>`coalesce(max(${standardClauses.seq}), 0)` })
        .from(standardClauses)
        .where(eq(standardClauses.docId, doc.id))) as unknown as { m: number }[];
      let seq = m ?? 0;
      for (let i = 0; i < clauses.length; i++) {
        seq++;
        await tx.insert(standardClauses).values({
          memexId: doc.memexId,
          docId: doc.id,
          sectionId: s.id,
          seq,
          position: i + 1,
          body: clauses[i],
        });
      }
      await tx
        .update(docSections)
        .set({ content: clauses.join("\n\n"), preamble: null, updatedAt: new Date() })
        .where(eq(docSections.id, s.id));
    });
  }

  log(`\n\n================ pilot complete; backup in ${BACKUP} (--restore to undo) ================`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PILOT FAILED:", e); // eslint-disable-line no-console
    process.exit(1);
  });
