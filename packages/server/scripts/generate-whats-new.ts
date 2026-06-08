// spec-200 t-3: generate What's New feed entries at the daily prod promotion.
//
// dec-2 (promotion-time) + dec-3 (global feed sourced from memex-building-itself):
// at deploy this drafts a What/Why entry (via Claude) for every shippable,
// not-yet-published Spec in mindset-prod/memex-building-itself and publishes it.
//
// Idempotent + bounded + non-destructive: already-published Specs are skipped
// BEFORE any LLM call (runWhatsNewGeneration), and the run is capped per deploy
// (spec-178 t-5 lesson — a deploy step must never fan out unboundedly). Resumes
// on the next deploy if capped.
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/generate-whats-new.ts
//
// CI/CD wiring: packages/server/deploy.sh runs this AFTER migrations, bounded by
// `timeout` and non-gating (|| echo), so a hiccup can never fail a live deploy.
// On INT (where the memex may not exist) it no-ops cleanly.

import { eq, and } from "drizzle-orm";
import { db } from "../src/db/connection.js";
import { memexes, namespaces } from "../src/db/schema.js";
import { runWhatsNewGeneration } from "../src/services/whats-new-generation.js";

// The single global source of What's New (dec-3). Overridable for non-canonical envs.
const NAMESPACE_SLUG = process.env.WHATS_NEW_NAMESPACE ?? "mindset-prod";
const MEMEX_SLUG = process.env.WHATS_NEW_MEMEX ?? "memex-building-itself";

async function main(): Promise<void> {
  const [row] = await db
    .select({ memexId: memexes.id })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(and(eq(namespaces.slug, NAMESPACE_SLUG), eq(memexes.slug, MEMEX_SLUG)));

  if (!row) {
    // INT / any env without the source memex — nothing to do, clean no-op.
    console.log(
      `[whats-new] ${NAMESPACE_SLUG}/${MEMEX_SLUG} not found in this environment — skipping (no-op).`,
    );
    process.exit(0);
  }

  console.log(`[whats-new] generating entries for ${NAMESPACE_SLUG}/${MEMEX_SLUG}…`);
  const result = await runWhatsNewGeneration(row.memexId);
  console.log(
    `[whats-new] done — generated ${result.generated}, skipped ${result.skipped} of ${result.total} shippable spec(s)` +
      (result.capped ? " (CAPPED this run — remaining specs publish on the next deploy)." : "."),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[whats-new] failed:", err);
  process.exit(1);
});
