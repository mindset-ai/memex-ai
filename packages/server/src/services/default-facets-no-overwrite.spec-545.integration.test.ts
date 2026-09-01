// spec-545 t-4 — seeding and backfill CANNOT overwrite an edited facet description
// (ac-11, ac-12).
//
// WHY THIS IS THE LOAD-BEARING TEST OF THE SPEC. spec-545 changes two facet
// descriptions in two places that do not talk to each other: the product default in the
// fixture, and the LIVE rows an agent actually reads. No code path can write the live
// rows — the `facets` tool exposes only `list`, facet-vocab.ts has no writer, and
// default-facets.ts only inserts — so the live change is a manual UPDATE (t-5).
//
// That manual write is only sane because re-seeding provably cannot revert it:
// seedDefaultFacetsForOwner early-returns on the zero-row guard and its insert is
// onConflictDoNothing, and backfillDefaultFacetsAllOwners just loops that same guarded
// seed. Both facts were established by READING the code during specify. Reading is not
// a guarantee — a later refactor to onConflictDoUpdate would silently revert production
// data on the next provisioning run, with nothing failing. These tests make that
// refactor loud.
//
// The sentinel stands in for the hand-edited production description; nothing here
// depends on spec-545's actual wording, so the guard outlives this Spec.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets, namespaces, memexes } from "../db/schema.js";
import { DEFAULT_FACETS } from "../db/default-facets.fixture.js";
import { seedDefaultFacetsForOwner, backfillDefaultFacetsAllOwners } from "./default-facets.js";
import { makeTestMemex, makePersonalTestMemex } from "./test-helpers.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-545/acs/ac-${n}`;

/** The facet whose description spec-545 actually rewords in production. */
const EDITED_KEY = "architecture";

type Owner = { ownerType: "org" | "memex"; ownerId: string };

async function orgIdFor(memexId: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (!row?.orgId) throw new Error("spec-545: could not resolve org for test memex");
  return row.orgId;
}

async function rowsFor(owner: Owner): Promise<{ key: string; description: string }[]> {
  return db
    .select({ key: facets.key, description: facets.description })
    .from(facets)
    .where(and(eq(facets.ownerType, owner.ownerType), eq(facets.ownerId, owner.ownerId)));
}

async function descriptionOf(owner: Owner, key: string): Promise<string | undefined> {
  return (await rowsFor(owner)).find((r) => r.key === key)?.description;
}

/** Hand-edit one description, the way t-5 will in int and prod. */
async function writeSentinel(owner: Owner, key: string): Promise<string> {
  // Unique per call (std-37): a shared literal is the habit that bites the next test.
  const sentinel = `spec-545 sentinel ${randomUUID()}`;
  await db
    .update(facets)
    .set({ description: sentinel })
    .where(
      and(
        eq(facets.ownerType, owner.ownerType),
        eq(facets.ownerId, owner.ownerId),
        eq(facets.key, key),
      ),
    );
  return sentinel;
}

let editedOwner: Owner; // an org whose description is hand-edited
let untouchedOwner: Owner; // a second org, seeded, never edited
let emptyMemexId: string; // a personal memex with NO vocabulary yet

beforeAll(async () => {
  editedOwner = { ownerType: "org", ownerId: await orgIdFor(await makeTestMemex("s545edit")) };
  untouchedOwner = { ownerType: "org", ownerId: await orgIdFor(await makeTestMemex("s545keep")) };
  emptyMemexId = await makePersonalTestMemex("s545empty");
});

afterAll(async () => {
  // Scoped to what this file created, and idempotent (std-37).
  for (const owner of [editedOwner, untouchedOwner, { ownerType: "memex" as const, ownerId: emptyMemexId }]) {
    await db
      .delete(facets)
      .where(and(eq(facets.ownerType, owner.ownerType), eq(facets.ownerId, owner.ownerId)))
      .catch(() => {});
  }
});

describe("spec-545: re-seeding one owner cannot revert a hand-edited description (ac-11)", () => {
  it("the sentinel survives a re-seed, and no rows are added", async () => {
    tagAc(AC(11));

    await seedDefaultFacetsForOwner(editedOwner);
    const countAfterSeed = (await rowsFor(editedOwner)).length;
    expect(countAfterSeed).toBe(DEFAULT_FACETS.length);

    const sentinel = await writeSentinel(editedOwner, EDITED_KEY);
    expect(await descriptionOf(editedOwner, EDITED_KEY)).toBe(sentinel);

    // The provisioning path, run again against an owner that already has a vocabulary.
    await seedDefaultFacetsForOwner(editedOwner);

    expect(
      await descriptionOf(editedOwner, EDITED_KEY),
      "re-seeding reverted a hand-edited description — spec-545's live-row change (t-5) " +
        "would be silently undone on the next provisioning run",
    ).toBe(sentinel);
    expect(await rowsFor(editedOwner)).toHaveLength(countAfterSeed);
  });

  it("leaves the owner's other descriptions alone too", async () => {
    tagAc(AC(11));
    // Scoped narrowly on purpose: a re-seed that rewrote every row EXCEPT the edited one
    // would still be a data-loss bug, and the sentinel assertion alone would miss it.
    const rows = await rowsFor(editedOwner);
    const others = rows.filter((r) => r.key !== EDITED_KEY);
    const fixtureByKey = new Map(DEFAULT_FACETS.map((f) => [f.key, f.description]));
    for (const row of others) {
      expect(row.description).toBe(fixtureByKey.get(row.key));
    }
  });
});

describe("spec-545: the all-owners backfill is equally non-destructive (ac-12)", () => {
  it("keeps the sentinel, adds no rows, and still seeds an owner that had none", async () => {
    tagAc(AC(12));

    await seedDefaultFacetsForOwner(untouchedOwner);
    const sentinel = await writeSentinel(untouchedOwner, EDITED_KEY);

    const emptyOwner: Owner = { ownerType: "memex", ownerId: emptyMemexId };
    // The precondition that makes the last assertion meaningful.
    expect(await rowsFor(emptyOwner)).toHaveLength(0);

    // The operator action most likely to be run after this Spec's deploy.
    await backfillDefaultFacetsAllOwners();

    expect(
      await descriptionOf(untouchedOwner, EDITED_KEY),
      "the all-owners backfill reverted a hand-edited description",
    ).toBe(sentinel);
    expect(await rowsFor(untouchedOwner)).toHaveLength(DEFAULT_FACETS.length);

    // NOT just "nothing happened": a no-op implementation would pass every assertion
    // above. The backfill must still do its job for an owner with no vocabulary.
    expect(
      (await rowsFor(emptyOwner)).map((r) => r.key).sort(),
      "the backfill skipped an owner with zero facets — this test would otherwise pass " +
        "against a function that does nothing at all",
    ).toEqual(DEFAULT_FACETS.map((f) => f.key).sort());
  });

  it("survives a second backfill — idempotent, not merely first-run-safe", async () => {
    tagAc(AC(12));
    const before = await descriptionOf(untouchedOwner, EDITED_KEY);

    await backfillDefaultFacetsAllOwners();

    expect(await descriptionOf(untouchedOwner, EDITED_KEY)).toBe(before);
    expect(await rowsFor(untouchedOwner)).toHaveLength(DEFAULT_FACETS.length);
    expect(await rowsFor({ ownerType: "memex", ownerId: emptyMemexId })).toHaveLength(
      DEFAULT_FACETS.length,
    );
  });
});
