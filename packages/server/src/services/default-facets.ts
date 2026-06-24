// Default facet vocabulary — seed at org provisioning (spec-340 t-2 / dec-7).
//
// Seeds every new organization with its own copy of the default 16 facets so an
// org lands with a working vocabulary the classifier and the ballot can use. The
// canonical content lives ONCE in db/default-facets.fixture.ts; this module is
// the idempotent write path. Mirrors services/default-standards.ts (the spec-184
// sibling): defaults are ORDINARY editable rows with NO marker, so idempotency
// keys off "the org already has ≥1 facet" (the zero-row guard) — which also means
// a backfill touches only orgs with an empty vocabulary.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets } from "../db/schema.js";
import { DEFAULT_FACETS } from "../db/default-facets.fixture.js";

// Count this org's facet rows. The seed/backfill guard: an org with ANY facet is
// left untouched (no marker → we can't distinguish ours from the org's own edits).
async function countFacets(orgId: string): Promise<number> {
  const rows = await db.select({ id: facets.id }).from(facets).where(eq(facets.orgId, orgId));
  return rows.length;
}

// Seed an org with the default 16 facets. Idempotent via the zero-row guard plus
// onConflictDoNothing on (org_id, key), so a concurrent double-seed (e.g. an
// email-resend race) is absorbed rather than 23505-ing. `ord` follows fixture order.
export async function seedDefaultFacets(orgId: string): Promise<void> {
  if ((await countFacets(orgId)) > 0) return;
  await db
    .insert(facets)
    .values(
      DEFAULT_FACETS.map((f, i) => ({
        orgId,
        key: f.key,
        name: f.name,
        description: f.description,
        ord: i,
      })),
    )
    .onConflictDoNothing();
}

// Best-effort wrapper fired from the org-provisioning funnel. A rejection is
// caught and logged so it never propagates out of org creation (the org must
// still be created even if the seed fails). Gated off by
// MEMEX_DEFAULT_FACETS_SEED=off; the seed's own suites stub it back on (the gate
// is read at call time). Mirrors seedDefaultStandardsBestEffort.
export async function seedDefaultFacetsBestEffort(orgId: string): Promise<void> {
  if (process.env.MEMEX_DEFAULT_FACETS_SEED === "off") return;
  try {
    await seedDefaultFacets(orgId);
  } catch (err) {
    console.error("[default-facets seed]", err);
  }
}
