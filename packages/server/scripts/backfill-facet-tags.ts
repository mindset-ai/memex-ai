// Backfill facet tags onto EXISTING standards' clauses (spec-340 t-11 / dec-8).
//
// New/edited clauses get their facets inline via add_clause/edit_clause (the agent
// classifies). THIS script is the one-time catch-up for standards authored BEFORE
// the feature: it classifies every clause of every standard in a memex with a REAL
// Anthropic call and writes the tags. Idempotent (tagClause replaces a clause's
// tags), so re-running is safe.
//
// This is a LOCAL, operator/agent-run script — NOT a server request/write path. It
// is the ONLY place the server-side LLM classifier engine is invoked (dec-8). Needs
// ANTHROPIC_API_KEY + DATABASE_URL in the environment.
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
  const { standards, clauses } = await backfillFacetTagsForMemex(memexId);
  console.log(`[facet-backfill] done — ${standards} standard(s), ${clauses} clause(s) classified + tagged.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[facet-backfill] failed:", err);
  process.exit(1);
});
