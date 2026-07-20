// One-off backfill (spec-497 t-3, dec-3): stamp drift_decision_id onto historical
// OPEN drift comments by parsing their body back to the decision that triggered them.
//
// Drift comments written before this Spec carry the triggering decision only inside
// their prose (`Decision dec-N ("<title>") was resolved…`). This script recovers the
// link — matching on the decision's per-spec seq + title within the memex — so the
// knowledge-graph endpoint can draw decision→standard drift edges for old drift too.
// Rows that don't parse, or whose (seq,title) is ambiguous, stay NULL (badge-only).
// Idempotent: only touches rows where drift_decision_id IS NULL.
//
// LOCAL / operator-run — not a server request path, not run by deploy. Needs
// DATABASE_URL in the environment.
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/backfill-drift-decision.ts <memexId>

import { backfillDriftDecisionLinks } from "../src/services/standards.js";

async function main(): Promise<void> {
  const memexId = process.argv[2];
  if (!memexId || memexId.startsWith("--")) {
    console.error("usage: tsx scripts/backfill-drift-decision.ts <memexId>");
    process.exit(1);
  }
  console.log(`[drift-backfill] linking historical drift comments for memex ${memexId}…`);
  const { scanned, linked, unresolved } = await backfillDriftDecisionLinks(memexId);
  console.log(
    `[drift-backfill] done — ${scanned} unlinked drift comment(s) scanned, ` +
      `${linked} linked, ${unresolved} left NULL (unparseable or ambiguous — badge-only).`,
  );
  process.exit(0);
}

void main();
