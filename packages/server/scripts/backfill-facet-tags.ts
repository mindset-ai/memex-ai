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
// Usage:
//   pnpm --filter @memex/server tsx scripts/backfill-facet-tags.ts <memexId>

import { backfillFacetTagsForMemex } from "../src/services/facet-classifier.js";

async function main(): Promise<void> {
  const memexId = process.argv[2];
  if (!memexId) {
    console.error("usage: tsx scripts/backfill-facet-tags.ts <memexId>");
    process.exit(1);
  }
  console.log(`[facet-backfill] classifying standards' clauses for memex ${memexId}…`);
  // Progress ticks for the long run — every 25 clauses and at the end (the pool runs
  // CLASSIFY_CONCURRENCY in flight, so this reports completions, not start order).
  const { standards, clauses } = await backfillFacetTagsForMemex(memexId, {
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) {
        console.log(`[facet-backfill]   ${done}/${total} clauses classified…`);
      }
    },
  });
  console.log(`[facet-backfill] done — ${standards} standard(s), ${clauses} clause(s) classified + tagged.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[facet-backfill] failed:", err);
  process.exit(1);
});
