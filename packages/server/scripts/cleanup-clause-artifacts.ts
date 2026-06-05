// spec-150: deterministic one-shot cleanup of two clause-body artifacts the LLM
// translator left in a small fraction of clauses:
//   1. a retained leading list marker ("- ", "* ", "1. ")  → the clause is the
//      bullet's CONTENT, not the bullet.
//   2. a leading space immediately inside an opening backtick ("` FOO`" → "`FOO`").
//
// Both are anchored to the START of the body, so legitimate mid-clause cases (e.g. a
// clause that literally describes a `- ` bullet marker) are untouched. After editing
// bodies, the affected sections' content is recomputed as the ordered clause join so
// the partition invariant (content === clauses.join) still holds.
//
//   tsx scripts/cleanup-clause-artifacts.ts          # dry run (default): report only
//   tsx scripts/cleanup-clause-artifacts.ts --apply  # apply the fixes

import "dotenv/config";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../src/db/connection.js";
import { documents, docSections, standardClauses } from "../src/db/schema.js";

// Bullet markers only. Numbered markers (`1.`) are left intact: their digit carries
// sequence meaning in the rendered procedure.
const LEADING_LIST_MARKER = /^\s*[-*]\s+/;
const LEADING_BACKTICK_SPACE = /^`\s+/;

function clean(body: string): string {
  return body.replace(LEADING_LIST_MARKER, "").replace(LEADING_BACKTICK_SPACE, "`");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const rows = await db
    .select({
      id: standardClauses.id,
      sectionId: standardClauses.sectionId,
      handle: documents.handle,
      seq: standardClauses.seq,
      body: standardClauses.body,
    })
    .from(standardClauses)
    .innerJoin(documents, eq(standardClauses.docId, documents.id))
    .where(and(eq(documents.docType, "standard"), ne(standardClauses.status, "deleted")));

  const changed = rows
    .map((r) => ({ ...r, next: clean(r.body) }))
    .filter((r) => r.next !== r.body);

  const log = (...a: unknown[]) => console.log(...a); // eslint-disable-line no-console
  log(`[cleanup] ${changed.length} clause(s) need fixing (of ${rows.length})`);
  for (const c of changed) {
    log(`  ${c.handle} cl-${c.seq}:`);
    log(`    - ${JSON.stringify(c.body.slice(0, 90))}`);
    log(`    + ${JSON.stringify(c.next.slice(0, 90))}`);
  }
  if (!changed.length) return;
  if (!apply) {
    log("\n[cleanup] dry run — re-run with --apply to write these changes.");
    return;
  }

  const affectedSections = [...new Set(changed.map((c) => c.sectionId))];
  await db.transaction(async (tx) => {
    for (const c of changed) {
      await tx
        .update(standardClauses)
        .set({ body: c.next, updatedAt: new Date() })
        .where(eq(standardClauses.id, c.id));
    }
    // Recompute each affected section's content as the ordered clause join.
    for (const sectionId of affectedSections) {
      const live = await tx
        .select({ body: standardClauses.body })
        .from(standardClauses)
        .where(and(eq(standardClauses.sectionId, sectionId), ne(standardClauses.status, "deleted")))
        .orderBy(asc(standardClauses.position));
      await tx
        .update(docSections)
        .set({ content: live.map((c) => c.body).join("\n\n"), updatedAt: new Date() })
        .where(eq(docSections.id, sectionId));
    }
  });
  log(`\n[cleanup] applied: ${changed.length} clauses fixed, ${affectedSections.length} sections recomposed.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e); // eslint-disable-line no-console
    process.exit(1);
  });
