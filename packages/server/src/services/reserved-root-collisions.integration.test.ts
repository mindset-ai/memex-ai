// spec-515 t-3 / ac-7 — the deploy precondition for the reserved-root fix.
//
// Adding a root to RESERVED_API_ROOTS makes parseMemexPath no-op for it, which
// strands any existing tenant whose slug is that word: the resolver stops
// resolving it, so `/<root>/<memex>/…` becomes unroutable. dec-3 verified by hand
// on 2026-07-28 that prod (328 namespaces) and int (78) held no collision — but
// that is a point-in-time result. A namespace can be created between then and any
// future deploy, so the check has to be mechanical and it has to BLOCK.
//
// FIXTURE NOTE (learned the hard way). An earlier draft inserted a bare
// `namespaces` row with kind='org' and no owning org, then deleted it in afterAll.
// That row is malformed — every org-kind namespace is expected to carry an
// ownerOrgId — and its presence reddened six unrelated share / doc_views
// integration tests in the full suite while passing in isolation. Proven by
// substituting an inert 614th test file, which left the suite green: the shard
// reshuffle was not the cause, the malformed row was. So this file builds tenants
// only through `makeTestMemex()`, the sanctioned fixture (namespace + org + memex
// in one transaction, `uniqueSlug` per std-37 cl-2), and never hand-rolls one.
//
// The collision-detecting function takes its root set as a parameter, so the test
// passes the fixture's own generated slug as the "root" — no fixed literal, no
// need to name a real reserved word to exercise the namespace branch. A separate
// assertion pins the production default to the resolver's real set so the two
// cannot drift.

import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { memexes, namespaces, namespaceSlugReservations } from "../db/schema.js";
import { reservedApiRoots } from "../middleware/memex-resolver.js";
import { makeTestMemex } from "./test-helpers.js";
import {
  findReservedRootSlugCollisions,
  type ReservedRootCollision,
} from "./reserved-root-collisions.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-7";

// Reservation slugs are per-worker-unique (std-37 cl-1) and must satisfy the
// table's CHECK constraint on the slug grammar `[a-z0-9][a-z0-9-]{0,38}`.
const WORKER = process.env.VITEST_POOL_ID ?? "0";
const RESERVATION_SLUG = `zzz515-resv-${WORKER}`;

const createdReservationSlugs: string[] = [];

/** The slug of a well-formed tenant created via the sanctioned fixture. */
async function makeTenantSlug(): Promise<string> {
  const memexId = await makeTestMemex("s515");
  const [row] = await db
    .select({ slug: namespaces.slug })
    .from(namespaces)
    .innerJoin(memexes, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId));
  return row.slug;
}

afterAll(async () => {
  // Only the reservation rows are torn down (scoped + idempotent, std-37 cl-6).
  // The `makeTestMemex` tenants are left in place: they carry uniqueSlug-generated
  // slugs that collide with nothing, and deleting namespaces cascades — the blast
  // radius of cleanup is larger than the cost of leaving them, which is the
  // convention the rest of the suite follows.
  if (createdReservationSlugs.length > 0) {
    await db
      .delete(namespaceSlugReservations)
      .where(inArray(namespaceSlugReservations.slug, createdReservationSlugs));
  }
});

describe("findReservedRootSlugCollisions (spec-515 t-3 / ac-7)", () => {
  it("returns nothing when no namespace or reservation holds the root", async () => {
    tagAc(AC);
    expect(await findReservedRootSlugCollisions([`zzz515-absent-${WORKER}`])).toEqual([]);
  });

  it("reports a namespace whose slug IS a reserved root", async () => {
    tagAc(AC);
    const slug = await makeTenantSlug();
    expect(await findReservedRootSlugCollisions([slug])).toEqual<ReservedRootCollision[]>([
      { slug, source: "namespace" },
    ]);
  });

  it("reports a slug held in the post-rename reservation table", async () => {
    // std-3 cl-13 keeps a renamed-away slug reserved for 30 days, reclaimable in
    // that window — as much a collision risk as a live namespace. Checking only
    // `namespaces` would miss it.
    tagAc(AC);
    await db.insert(namespaceSlugReservations).values({
      slug: RESERVATION_SLUG,
      reservedUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    createdReservationSlugs.push(RESERVATION_SLUG);

    expect(
      await findReservedRootSlugCollisions([RESERVATION_SLUG]),
    ).toEqual<ReservedRootCollision[]>([{ slug: RESERVATION_SLUG, source: "reservation" }]);
  });

  it("reports both sources together, deterministically ordered", async () => {
    tagAc(AC);
    const slug = await makeTenantSlug();
    const both = await findReservedRootSlugCollisions([slug, RESERVATION_SLUG]);
    expect(both).toHaveLength(2);
    expect(both.map((c) => c.source).sort()).toEqual(["namespace", "reservation"]);
  });

  it("defaults to the resolver's effective reserved set, not a copy", async () => {
    // The failure this guards against: someone hand-copies the root list into the
    // check, the resolver's list grows, and the check keeps reporting green against
    // the stale copy. Asserting on the default parameter is what forecloses that.
    tagAc(AC);
    const seen = new Set<string>();
    await findReservedRootSlugCollisions(undefined, {
      onRootsResolved: (roots) => {
        for (const r of roots) seen.add(r);
      },
    });
    expect(seen).toEqual(new Set(reservedApiRoots()));
    // Spot-check the two roots whose absence was doing real damage in production.
    expect(seen).toContain("email");
    expect(seen).toContain("test-events");
  });

  it("is read-only — running it changes no rows", async () => {
    tagAc(AC);
    const before = await db.select({ id: namespaces.id }).from(namespaces);
    await findReservedRootSlugCollisions();
    const after = await db.select({ id: namespaces.id }).from(namespaces);
    expect(after.length).toBe(before.length);
  });
});
