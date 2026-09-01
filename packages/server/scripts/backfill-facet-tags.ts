// Backfill facet tags onto EXISTING standards' clauses (spec-340 t-4 / dec-8).
//
// THIS script is the one-time catch-up for standards authored before facets existed:
// it classifies every clause of every standard in a memex with a REAL Anthropic call
// (Claude Opus 4.8) and writes the tags. Idempotent (tagClause replaces a clause's
// tags), so re-running is safe.
//
// dec-8: this is a LOCAL, operator/agent-run script — NOT a server request/write path,
// and NOT run by this Spec's deploy. It is the ONLY invoker of the server-side LLM
// classifier engine; a regression guard pins that no MCP handler/route imports it.
// Needs ANTHROPIC_API_KEY + DATABASE_URL in the environment.
//
// (The separate scripts/backfill-default-facets.ts seeds the VOCABULARY and makes no
// LLM calls — run that first so there is a vocabulary to classify against.)
//
// spec-423 t-7 / dec-9 — the GAP-BACKFILL: pass `--gap-only` to classify ONLY clauses
// that have no facet tag yet (those authored while Phase 1 was inert, before the
// add_clause hard-fail landed). Run this ONCE per memex just before the Phase 2 deploy
// serves, so no clause is left silently unclassified.
//
// ⚠ THE DEFAULT IS LOAD-BEARING (spec-545 ac-4 / ac-10). Without `--gap-only` this
// re-classifies EVERY clause in the memex against the CURRENT facet descriptions —
// tagClause deletes then re-inserts — so a bare run after a description is reworded
// silently re-tags the whole corpus under the new wording. spec-545 changed the
// `architecture` and `code-style` descriptions on that understanding and forbids a
// non-gap-only run; a regression guard pins this default so that warning cannot go
// stale (src/__regression__/facet-backfill-gap-only-default.spec-545.regression.test.ts).
// If you deliberately flip the default, revise spec-545's Operations lens too.
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/backfill-facet-tags.ts <memexId> [--gap-only]

import { backfillFacetTagsForMemex } from "../src/services/facet-classifier.js";

async function main(): Promise<void> {
  const memexId = process.argv[2];
  const gapOnly = process.argv.includes("--gap-only");
  if (!memexId || memexId.startsWith("--")) {
    console.error("usage: tsx scripts/backfill-facet-tags.ts <memexId> [--gap-only]");
    process.exit(1);
  }
  console.log(
    `[facet-backfill] classifying ${gapOnly ? "UNTAGGED " : ""}clauses for memex ${memexId}…`,
  );
  // Progress ticks for the long run — every 25 clauses and at the end (the pool runs
  // CLASSIFY_CONCURRENCY in flight, so this reports completions, not start order).
  // Resilience (PR retrim): a clause that still fails after all retries is skipped
  // (left untagged) and logged here, so one bad clause never aborts a long bulk run —
  // re-run with --gap-only to retry the skipped ones once the cause is understood.
  const skipped: string[] = [];
  const { standards, clauses } = await backfillFacetTagsForMemex(memexId, {
    gapOnly,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) {
        console.log(`[facet-backfill]   ${done}/${total} clauses classified…`);
      }
    },
    onClauseError: (clauseId, err) => {
      skipped.push(clauseId);
      console.warn(`[facet-backfill]   ⚠ skipped clause ${clauseId} (left untagged): ${(err as Error)?.message ?? err}`);
    },
  });
  console.log(
    `[facet-backfill] done — ${standards} standard(s), ${clauses} clause(s) processed, ` +
      `${skipped.length} skipped${skipped.length > 0 ? " (re-run with --gap-only to retry)" : ""}.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[facet-backfill] failed:", err);
  process.exit(1);
});
