// spec-515 t-3 / ac-7 — is any namespace slug squatting a reserved API root?
//
// WHY THIS EXISTS. `memexResolver` treats a word in `RESERVED_API_ROOTS` as "not a
// tenant", so `parseMemexPath` returns null for it and tenant resolution no-ops.
// That is exactly what makes a flat `/api/<root>` mount reachable — and it is also
// what would strand a tenant that already OWNS that word as its namespace slug:
// `/<root>/<memex>/…` would stop resolving. The two features are competing for one
// vocabulary (std-3 cl-7), and this check is the interlock.
//
// dec-3 verified by hand on 2026-07-28 that prod (328 namespaces) and int (78) held
// no collision. That result expires the moment someone signs up: it is a
// point-in-time observation, not an invariant. This function makes it repeatable so
// the deploy can enforce it (see scripts/check-reserved-root-collisions.ts).
//
// STRICTLY READ-ONLY. It runs as a deploy PRE-condition, before migrations, against
// a live database. It must never write, and it must never mutate its inputs.

import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, namespaceSlugReservations } from "../db/schema.js";
import { reservedApiRoots } from "../middleware/memex-resolver.js";

/** A word that is BOTH a reserved API root and a claimed namespace slug. */
export interface ReservedRootCollision {
  slug: string;
  /**
   * `namespace` — a live tenant owns the slug; reserving the root makes it
   * unroutable right now.
   * `reservation` — a post-rename hold (std-3 cl-13, 30 days). Nobody is stranded
   * today, but the slug is reclaimable inside the window, so shipping over it
   * converts a latent collision into a live one.
   */
  source: "namespace" | "reservation";
}

interface Hooks {
  /**
   * Test seam (not used in production): reports the root set the call actually
   * resolved. Exists so a test can pin the DEFAULT to the resolver's live set —
   * the failure mode being guarded is a hand-copied root list that keeps passing
   * while the resolver's list grows past it.
   */
  onRootsResolved?: (roots: readonly string[]) => void;
}

/**
 * Returns every reserved API root that is currently claimed as a namespace slug or
 * held in the post-rename reservation table. Empty array = safe to ship.
 *
 * `roots` defaults to the resolver's own effective set (`reservedApiRoots()`) so the check cannot
 * drift from the thing it is checking. Pass an explicit set only in tests.
 */
export async function findReservedRootSlugCollisions(
  roots: Iterable<string> = reservedApiRoots(),
  hooks: Hooks = {},
): Promise<ReservedRootCollision[]> {
  const candidates = [...new Set(roots)];
  hooks.onRootsResolved?.(candidates);

  // `inArray` with an empty list generates invalid SQL in some drivers, and an
  // empty root set trivially has no collisions — bail before touching the DB.
  if (candidates.length === 0) return [];

  const [claimed, held] = await Promise.all([
    db
      .select({ slug: namespaces.slug })
      .from(namespaces)
      .where(inArray(namespaces.slug, candidates)),
    db
      .select({ slug: namespaceSlugReservations.slug })
      .from(namespaceSlugReservations)
      .where(inArray(namespaceSlugReservations.slug, candidates)),
  ]);

  // Deterministic order so a deploy log diff is readable and a test can assert
  // on the array without sorting at every call site.
  return [
    ...claimed.map((r) => ({ slug: r.slug, source: "namespace" as const })),
    ...held.map((r) => ({ slug: r.slug, source: "reservation" as const })),
  ].sort((a, b) => a.slug.localeCompare(b.slug) || a.source.localeCompare(b.source));
}

/** Human-readable failure text for the deploy log. */
export function formatCollisions(collisions: readonly ReservedRootCollision[]): string {
  return collisions
    .map(
      (c) =>
        c.source === "namespace"
          ? `  ✗ "${c.slug}" is a LIVE namespace slug — reserving it makes that tenant unroutable`
          : `  ✗ "${c.slug}" is held in namespace_slug_reservations — reclaimable inside the 30-day window (std-3 cl-13)`,
    )
    .join("\n");
}
