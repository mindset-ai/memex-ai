// Default facet vocabulary seeding (spec-340 t-2 / t-3, dec-7).
//
// Seeds an owner (an org, or a personal memex with no owning org) with its own copy
// of the default 16 facets so it lands with a working vocabulary. The canonical
// content lives ONCE in db/default-facets.fixture.ts; this module is the idempotent
// write path. Mirrors services/default-standards.ts (the spec-184 sibling): defaults
// are ORDINARY editable rows with NO marker, so idempotency keys off "the owner
// already has ≥1 facet" (the zero-row guard) — which also means a backfill touches
// only owners with an empty vocabulary.
//
// std-8: the facets table is owner-config (like org_scaffold_additions) with no
// bus entity and no SSE subscriber in phase 1 (the inert foundation), so these
// writes do not route through mutate(). Allowlisted in
// mutate-coverage.static-scan.regression.test.ts; route through mutate() in phase 2
// when a live editing/pill surface lands.

import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets, memexes, namespaces, orgs } from "../db/schema.js";
import { DEFAULT_FACETS } from "../db/default-facets.fixture.js";
import { ownerForMemex, type FacetOwner } from "./shared/memex-ownership.js";

// Count an owner's facet rows. The seed/backfill guard: an owner with ANY facet is
// left untouched (no marker → we can't distinguish ours from the owner's own edits).
async function countFacets(owner: FacetOwner): Promise<number> {
  const rows = await db
    .select({ id: facets.id })
    .from(facets)
    .where(and(eq(facets.ownerType, owner.ownerType), eq(facets.ownerId, owner.ownerId)));
  return rows.length;
}

// Seed an owner with the default 16 facets. Idempotent via the zero-row guard plus
// onConflictDoNothing on (owner_type, owner_id, key), so a concurrent double-seed
// (e.g. an email-resend race) is absorbed rather than 23505-ing. `ord` follows
// fixture order. The stable key + immutable id are never rewritten.
export async function seedDefaultFacetsForOwner(owner: FacetOwner): Promise<void> {
  if ((await countFacets(owner)) > 0) return;
  await db
    .insert(facets)
    .values(
      DEFAULT_FACETS.map((f, i) => ({
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        key: f.key,
        name: f.name,
        description: f.description,
        ord: i,
      })),
    )
    .onConflictDoNothing();
}

// Best-effort wrapper fired from a provisioning funnel (org creation, t-3). A
// rejection is caught and logged so it never propagates out of creation (the owner
// must still be created even if the seed fails). Gated off by
// MEMEX_DEFAULT_FACETS_SEED=off (read at call time); mirrors
// seedDefaultStandardsBestEffort.
export async function seedDefaultFacetsForOwnerBestEffort(owner: FacetOwner): Promise<void> {
  if (process.env.MEMEX_DEFAULT_FACETS_SEED === "off") return;
  try {
    await seedDefaultFacetsForOwner(owner);
  } catch (err) {
    console.error("[default-facets seed]", err);
  }
}

// Best-effort seed for a memex by resolving its owner first (the personal-memex
// auto-seed hook, t-3). For an org-owned memex this resolves to the org owner; for a
// personal memex (no owning org) it resolves to the memex itself (dec-7).
export async function seedDefaultFacetsForMemexBestEffort(memexId: string): Promise<void> {
  if (process.env.MEMEX_DEFAULT_FACETS_SEED === "off") return;
  try {
    const owner = await ownerForMemex(memexId);
    if (owner) await seedDefaultFacetsForOwner(owner);
  } catch (err) {
    console.error("[default-facets seed]", err);
  }
}

// t-2 backfill: seed every existing org AND every existing personal memex with the
// default 16 (idempotent per owner via the zero-row guard). An owner with zero facets
// is a defect, not a valid state (ac-31). Returns counts for the operator's log.
export async function backfillDefaultFacetsAllOwners(): Promise<{
  orgs: number;
  personalMemexes: number;
}> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const o of orgRows) {
    await seedDefaultFacetsForOwner({ ownerType: "org", ownerId: o.id });
  }

  // Personal memexes: those under a user-kind namespace (no owning org). Each owns
  // its vocabulary directly (owner_type='memex').
  const personal = await db
    .select({ id: memexes.id })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(namespaces.kind, "user"));
  for (const m of personal) {
    await seedDefaultFacetsForOwner({ ownerType: "memex", ownerId: m.id });
  }

  return { orgs: orgRows.length, personalMemexes: personal.length };
}
