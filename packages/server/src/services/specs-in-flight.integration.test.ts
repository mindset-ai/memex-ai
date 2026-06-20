// spec-315 t-1 — "Your specs in flight" derivation.
// Tagged ac-8 (mechanism: activity_view, cross-memex, top-N/window, tenancy) and
// ac-2 (outcome: one card per recently-worked spec, click opens it).
//
// Isolation: we drive everything off a UNIQUE owner user (not the shared
// dev@memex.ai, which is enrolled across the whole suite), so the global
// cross-memex read only ever sees this test's seeded memexes — making ordering
// deterministic. Tests run as the table OWNER (RLS bypassed, std-36), so the
// service's explicit `memex_id` filters — not RLS — do the scoping here.
import { beforeAll, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLog, memexes, namespaces, orgMemberships, orgs } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { listSpecsInFlightForUser } from "./specs-in-flight.js";

const AC8 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-8";
const AC2 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-2";

const rand = () => Math.random().toString(36).slice(2, 8);
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000);

let slugSeq = 0;
function uniqueSlug(prefix: string): string {
  slugSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${slugSeq}-${rand()}`.slice(0, 39);
}

// Make a memex; optionally enroll `adminUserId` as an org administrator (= member).
async function makeMemex(
  prefix: string,
  adminUserId?: string,
): Promise<{ memexId: string; slug: string }> {
  const slug = uniqueSlug(prefix);
  const { ns, org, memex } = await db.transaction(async (tx) => {
    const [ns] = await tx.insert(namespaces).values({ slug, kind: "org" }).returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Test ${prefix}` })
      .returning();
    await tx.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    return { ns, org, memex };
  });
  if (adminUserId) {
    await db
      .insert(orgMemberships)
      .values({ userId: adminUserId, orgId: org.id, role: "administrator" })
      .onConflictDoNothing();
  }
  return { memexId: memex.id, slug: ns.slug };
}

async function seedActivity(memexId: string, briefId: string, actorUserId: string, at: Date) {
  await db.insert(activityLog).values({
    memexId,
    briefId,
    actorUserId,
    actorKind: "human",
    channel: "rest_ui",
    entity: "section",
    action: "updated",
    narrative: "seeded",
    createdAt: at,
  });
}

describe("listSpecsInFlightForUser (spec-315 t-1)", () => {
  let owner: string;
  let alice: string;
  let slugA: string;
  let slugB: string;
  let memexA: string;
  let memexB: string;
  let memexC: string;
  // doc ids (globally unique — handles like `spec-1` repeat across memexes)
  let idRecent: string;
  let idOlder: string;
  let idStale: string;
  let idOther: string;
  let idCreated: string;
  let idB: string;
  let idC: string;
  // handle of the recent spec, for the route assertion
  let hRecent: string;

  beforeAll(async () => {
    owner = (await upsertUserByEmail(`sif-owner-${Date.now()}-${rand()}@example.com`)).id;
    alice = (await upsertUserByEmail(`sif-alice-${Date.now()}-${rand()}@example.com`)).id;

    const A = await makeMemex("sif-a", owner); // owner is a member
    const B = await makeMemex("sif-b", owner); // owner is a member
    const C = await makeMemex("sif-c"); // owner is NOT a member
    memexA = A.memexId;
    slugA = A.slug;
    memexB = B.memexId;
    slugB = B.slug;
    memexC = C.memexId;

    // Specs authored by alice, so the owner's creation-branch does not auto-include
    // them; the owner's "worked on" is driven purely by the seeded activity below.
    const mk = (memexId: string, title: string) =>
      createDocDraft(memexId, title, "purpose", "spec", undefined, undefined, alice);

    const sRecent = await mk(memexA, "Alpha Recent");
    const sOlder = await mk(memexA, "Alpha Older");
    const sStale = await mk(memexA, "Alpha Stale");
    const sOther = await mk(memexA, "Alpha Other");
    const sB = await mk(memexB, "Bravo One");
    const sC = await mk(memexC, "Charlie One");
    // A spec the OWNER created, with no further activity — creation counts as worked-on.
    const sCreated = await createDocDraft(
      memexA,
      "Alpha Created",
      "purpose",
      "spec",
      undefined,
      undefined,
      owner,
    );
    idRecent = sRecent.id;
    idOlder = sOlder.id;
    idStale = sStale.id;
    idOther = sOther.id;
    idB = sB.id;
    idC = sC.id;
    idCreated = sCreated.id;
    hRecent = sRecent.handle;

    await seedActivity(memexA, sRecent.id, owner, daysAgo(1));
    await seedActivity(memexA, sOlder.id, owner, daysAgo(3));
    await seedActivity(memexA, sStale.id, owner, daysAgo(40)); // outside the 30-day window
    await seedActivity(memexA, sOther.id, alice, hoursAgo(2)); // not the owner → excluded
    await seedActivity(memexB, sB.id, owner, daysAgo(2));
    await seedActivity(memexC, sC.id, owner, hoursAgo(1)); // owner not a member of C → excluded
  });

  it("returns specs worked on across the user's memexes, newest first (ac-2, ac-8)", async () => {
    tagAc(AC8);
    tagAc(AC2);
    const ids = (await listSpecsInFlightForUser(owner)).map((r) => r.docId);
    expect(ids).toContain(idRecent);
    expect(ids).toContain(idOlder);
    expect(ids).toContain(idB);
    expect(ids).toContain(idCreated);
    // created (now) > recent (1d) > B (2d) > older (3d)
    expect(ids).toEqual([idCreated, idRecent, idB, idOlder]);
  });

  it("excludes stale (>window), others' activity, and non-member memexes (ac-8)", async () => {
    tagAc(AC8);
    const ids = (await listSpecsInFlightForUser(owner)).map((r) => r.docId);
    expect(ids).not.toContain(idStale); // outside the 30-day window
    expect(ids).not.toContain(idOther); // alice's activity, not the owner's
    expect(ids).not.toContain(idC); // memex C: owner is not a member (tenancy)
  });

  it("carries owning-memex provenance + canonical route per item (ac-2, ac-8)", async () => {
    tagAc(AC8);
    tagAc(AC2);
    const byId = new Map((await listSpecsInFlightForUser(owner)).map((r) => [r.docId, r]));
    const a = byId.get(idRecent)!;
    expect(a.memexId).toBe(memexA);
    expect(a.namespaceSlug).toBe(slugA);
    expect(a.memexSlug).toBe("main");
    expect(a.handle).toBe(hRecent);
    expect(a.path).toBe(`/${slugA}/main/specs/${hRecent}`);
    const b = byId.get(idB)!;
    expect(b.memexId).toBe(memexB);
    expect(b.path).toBe(`/${slugB}/main/specs/${b.handle}`);
  });

  it("caps at the requested limit, most-recent first (ac-2)", async () => {
    tagAc(AC2);
    const res = await listSpecsInFlightForUser(owner, { limit: 2 });
    expect(res.map((r) => r.docId)).toEqual([idCreated, idRecent]);
  });
});
