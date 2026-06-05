// spec-150 t-6: run the standards decomposition (LLM translator) behind the dec-4
// safety protocol.
//
//   tsx scripts/decompose-standards.ts            # backup, decompose, validate, spot-check
//   tsx scripts/decompose-standards.ts --restore  # roll back from the snapshot
//
// Per std-9 + std-26: run locally first, then int, then prod — never skip the backup,
// never proceed if validation reports a broken partition or an empty section.

import "dotenv/config";
import { asc, eq } from "drizzle-orm";
import { db } from "../src/db/connection.js";
import { documents, docSections, standardClauses } from "../src/db/schema.js";
import {
  backupStandards,
  decomposeAllStandards,
  validateClausePartition,
  restoreStandardsFromBackup,
} from "../src/services/standards-migration.js";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[decompose-standards] ${msg}`);
}

// Print one decomposed standard's before/after so a human can eyeball quality.
async function spotCheck(handle: string): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.handle, handle),
  });
  if (!doc) return;
  const sections = await db
    .select()
    .from(docSections)
    .where(eq(docSections.docId, doc.id))
    .orderBy(asc(docSections.seq));
  const clauses = await db
    .select()
    .from(standardClauses)
    .where(eq(standardClauses.docId, doc.id))
    .orderBy(asc(standardClauses.seq));
  // eslint-disable-next-line no-console
  console.log(`\n===== SPOT CHECK ${handle} "${doc.title}" — ${clauses.length} clauses =====`);
  for (const s of sections) {
    const cs = clauses.filter((c) => c.sectionId === s.id).sort((a, b) => a.position - b.position);
    // eslint-disable-next-line no-console
    console.log(`\n  s-${s.seq} ${s.title ?? s.sectionType} → ${cs.length} clauses`);
    cs.forEach((c) => console.log(`    [cl-${c.seq}] ${c.body}`)); // eslint-disable-line no-console
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--restore")) {
    log("restoring standards from snapshot...");
    await restoreStandardsFromBackup();
    log("restore complete.");
    return;
  }

  log("backing up standard sections (snapshot)...");
  const n = await backupStandards();
  log(`  snapshot captured: ${n} standard sections`);

  log("decomposing standards into clauses via the LLM translator...");
  const report = await decomposeAllStandards();
  log(`  decomposed ${report.sectionsDecomposed} sections into ${report.clausesCreated} clauses`);

  log("validating the partition invariant (content === clauses.join; no empty sections)...");
  const v = await validateClausePartition();
  if (v.contentMismatch.length > 0 || v.emptySections.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[decompose-standards] ABORT — ${v.contentMismatch.length} content mismatch(es), ` +
        `${v.emptySections.length} empty section(s) of ${v.checked} checked:`,
    );
    // eslint-disable-next-line no-console
    console.error("  mismatch:", v.contentMismatch.slice(0, 20).join(", ") || "(none)");
    // eslint-disable-next-line no-console
    console.error("  empty:   ", v.emptySections.slice(0, 20).join(", ") || "(none)");
    process.exitCode = 1;
    return;
  }
  log(`  OK — all ${v.checked} decomposed sections satisfy the partition invariant`);

  const sample = process.argv.find((a) => a.startsWith("std-")) ?? "std-1";
  await spotCheck(sample);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    // Print the MESSAGE only — never the raw error object. An Anthropic SDK error
    // embeds a Headers, which Node 24's util.inspect crashes on, masking the real
    // failure (the migration's own retry/abort messages are plain strings).
    // eslint-disable-next-line no-console
    console.error("[decompose-standards] FAILED:", (err as { message?: string })?.message ?? String(err));
    process.exit(1);
  });
