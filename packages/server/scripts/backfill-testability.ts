// Backfill TESTABILITY verdicts onto EXISTING standards' clauses (spec-151 t-6 / dec-6).
//
// THIS script is the catch-up for clauses authored without an agent-supplied testability
// verdict: it classifies every clause of every standard in a memex with a REAL metered
// Anthropic call (Claude Opus 4.8) and writes the is_obligation / testable / archetype
// columns. Idempotent under --gap-only (only NULL-verdict clauses are touched), so a
// second run classifies nothing new.
//
// dec-6 / spec-340 dec-8: this is a LOCAL, operator/agent-run script — NOT a server
// request/write path, and NOT run by this Spec's deploy. It is the ONLY server invoker of
// the testability classifier engine; a regression guard pins that no MCP handler/route
// imports it. Needs ANTHROPIC_API_KEY + DATABASE_URL in the environment.
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/backfill-testability.ts <memexId> [--gap-only]

import { backfillTestabilityForMemex } from "../src/services/testability-classifier.js";

async function main(): Promise<void> {
  const memexId = process.argv[2];
  const gapOnly = process.argv.includes("--gap-only");
  if (!memexId || memexId.startsWith("--")) {
    console.error("usage: tsx scripts/backfill-testability.ts <memexId> [--gap-only]");
    process.exit(1);
  }
  console.log(
    `[testability-backfill] classifying ${gapOnly ? "UNCLASSIFIED " : ""}clauses for memex ${memexId}…`,
  );
  const skipped: string[] = [];
  const { standards, clauses } = await backfillTestabilityForMemex(memexId, {
    gapOnly,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) {
        console.log(`[testability-backfill]   ${done}/${total} clauses classified…`);
      }
    },
    onClauseError: (clauseId, err) => {
      skipped.push(clauseId);
      console.warn(
        `[testability-backfill]   ⚠ skipped clause ${clauseId} (left unclassified): ${(err as Error)?.message ?? err}`,
      );
    },
  });
  console.log(
    `[testability-backfill] done — ${standards} standard(s), ${clauses} clause(s) processed, ` +
      `${skipped.length} skipped${skipped.length > 0 ? " (re-run with --gap-only to retry)" : ""}.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[testability-backfill] failed:", err);
  process.exit(1);
});
