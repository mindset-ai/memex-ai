// spec-150 dec-6: one-shot live smoke for the clause translator.
//   DATABASE_URL + ANTHROPIC_API_KEY are read from packages/server/.env (dotenv).
//   Run: pnpm exec tsx scripts/translate-smoke.ts
import "dotenv/config";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../src/db/connection.js";
import { documents, docSections } from "../src/db/schema.js";
import { translateSectionToClauses } from "../src/services/clause-translator.js";

async function main(): Promise<void> {
  const rows = await db
    .select({ id: docSections.id, content: docSections.content })
    .from(docSections)
    .innerJoin(documents, eq(docSections.docId, documents.id))
    .where(and(eq(documents.docType, "standard"), ne(docSections.status, "deleted")))
    .limit(40);
  // Prefer a prose section (no leading bullet) to prove the LLM splits prose the
  // mechanical cut could not.
  const prose =
    rows.find((r) => r.content.length > 200 && !/^\s*([-*+]|\d+[.)])\s/.test(r.content.trim())) ??
    rows[0];

  // eslint-disable-next-line no-console
  console.log("=== SECTION (first 700 chars) ===\n" + prose.content.slice(0, 700));
  const clauses = await translateSectionToClauses(prose.content);
  // eslint-disable-next-line no-console
  console.log(`\n=== ${clauses.length} CLAUSES ===`);
  clauses.forEach((c, i) => console.log(`[cl-${i + 1}] ${c}`)); // eslint-disable-line no-console
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("SMOKE FAILED:", e);
    process.exit(1);
  });
