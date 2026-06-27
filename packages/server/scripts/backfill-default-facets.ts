// Backfill the 16 default facets onto EVERY existing owner — every org AND every
// personal memex (spec-340 t-2, dec-7). Idempotent: an owner that already carries
// any facet is skipped (the zero-row guard).
//
// This seeds the VOCABULARY only — it makes NO LLM calls. (The separate, optional
// clause→facet classification backfill is scripts/backfill-facet-tags.ts.)
//
// Local, operator-run, one-time. Needs DATABASE_URL in the environment.
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/backfill-default-facets.ts

import { backfillDefaultFacetsAllOwners } from "../src/services/default-facets.js";

async function main(): Promise<void> {
  console.log("[default-facets backfill] seeding the 16 defaults into every org and personal memex…");
  const { orgs, personalMemexes } = await backfillDefaultFacetsAllOwners();
  console.log(
    `[default-facets backfill] done — ${orgs} org(s) and ${personalMemexes} personal memex(es) ensured seeded.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[default-facets backfill] failed:", err);
  process.exit(1);
});
