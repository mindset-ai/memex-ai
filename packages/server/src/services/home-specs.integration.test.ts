// spec-315 iteration 2 (t-6) — "Your specs" on Home: ownership-tiered, cross-Memex.
// Tagged ac-8 (mechanism: assigned|created|acted, 90d, demo included, two-tier by my-last
// activity, tenancy) and ac-2 (outcome: a card per spec I've worked on or own).
//
// Unique owner user so the global cross-memex read only sees this test's data. Tests run
// as the table OWNER (RLS bypassed); the service's explicit memex_id filters + membership
// iteration do the scoping.
import { beforeAll, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLog, docAssignees, documents, memexes, namespaces, orgMemberships, orgs } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { listHomeSpecs } from "./home-specs.js";

const AC8 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-8";
const AC2 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-2";

const rand = () => Math.random().toString(36).slice(2, 8);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
let slugSeq = 0;
const uniqueSlug = (p: string) => `${p}-${Date.now().toString(36)}-${(slugSeq += 1)}-${rand()}`.slice(0, 39);

async function makeMemex(prefix: string, adminUserId: string): Promise<{ memexId: string; slug: string }> {
  const slug = uniqueSlug(prefix);
  const { ns, org, memex } = await db.transaction(async (tx) => {
    const [ns] = await tx.insert(namespaces).values({ slug, kind: "org" }).returning();
    const [org] = await tx.insert(orgs).values({ namespaceId: ns.id, name: `Test ${prefix}` }).returning();
    await tx.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    const [memex] = await tx.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
    return { ns, org, memex };
  });
  await db.insert(orgMemberships).values({ userId: adminUserId, orgId: org.id, role: "administrator" }).onConflictDoNothing();
  return { memexId: memex.id, slug: ns.slug };
}

async function mkSpec(memexId: string, title: string, createdBy: string) {
  return createDocDraft(memexId, title, "purpose", "spec", undefined, undefined, createdBy);
}
async function seedActivity(memexId: string, briefId: string, actorUserId: string, at: Date) {
  await db.insert(activityLog).values({
    memexId, briefId, actorUserId, actorKind: "human", channel: "rest_ui",
    entity: "decision", action: "created", narrative: "created decision dec-2", createdAt: at,
  });
}

describe("listHomeSpecs (spec-315 t-6)", () => {
  let owner: string;
  let alice: string;
  let idCreated: string;
  let idAssigned: string;
  let idActed: string;
  let idDemo: string;
  let idStaleActed: string;
  let idOther: string;
  let idB: string;
  let idC: string;

  beforeAll(async () => {
    owner = (await upsertUserByEmail(`hs-owner-${Date.now()}-${rand()}@example.com`)).id;
    alice = (await upsertUserByEmail(`hs-alice-${Date.now()}-${rand()}@example.com`)).id;
    const A = await makeMemex("hs-a", owner);
    const B = await makeMemex("hs-b", owner);
    const C = await makeMemex("hs-c", alice); // owner NOT a member

    // created by me (+ recent activity). Created as alice then re-owned, so createDocDraft's
    // own section activity doesn't pollute MY last-activity — the seed below controls it.
    const created = await mkSpec(A.memexId, "Created by me", alice);
    idCreated = created.id;
    await db.update(documents).set({ createdByUserId: owner }).where(eq(documents.id, idCreated));
    await seedActivity(A.memexId, idCreated, owner, daysAgo(2));

    // assigned to me (created by alice), with OLDER activity than my other work
    const assigned = await mkSpec(A.memexId, "Assigned to me", alice);
    idAssigned = assigned.id;
    await db.insert(docAssignees).values({ memexId: A.memexId, docId: idAssigned, userId: owner, assignedBy: alice, assignedAt: daysAgo(5) });
    await seedActivity(A.memexId, idAssigned, owner, daysAgo(10));

    // acted on (created by alice), most recent of my work
    const acted = await mkSpec(A.memexId, "Acted on by me", alice);
    idActed = acted.id;
    await seedActivity(A.memexId, idActed, owner, daysAgo(1));

    // demo spec I created — must be INCLUDED (the iteration-1 bug)
    const demo = await mkSpec(A.memexId, "Demo notification system", alice);
    idDemo = demo.id;
    await db.update(documents).set({ isDemo: true, createdByUserId: owner }).where(eq(documents.id, idDemo));
    await seedActivity(A.memexId, idDemo, owner, daysAgo(3));

    // acted >90 days ago, not created/assigned by me — outside the window
    const stale = await mkSpec(A.memexId, "Stale", alice);
    idStaleActed = stale.id;
    await seedActivity(A.memexId, idStaleActed, owner, daysAgo(100));

    // alice's spec I never touched — excluded
    const other = await mkSpec(A.memexId, "Not mine", alice);
    idOther = other.id;

    // cross-memex: created by me in memex B
    const b = await mkSpec(B.memexId, "B spec", alice);
    idB = b.id;
    await db.update(documents).set({ createdByUserId: owner }).where(eq(documents.id, idB));
    await seedActivity(B.memexId, idB, owner, daysAgo(4));

    // memex C: I acted but am NOT a member — tenancy excludes it
    const c = await mkSpec(C.memexId, "C spec", alice);
    idC = c.id;
    await seedActivity(C.memexId, idC, owner, daysAgo(1));
  });

  it("includes assigned | created | acted within 90d, demo INCLUDED; excludes stale/other/non-member (ac-2, ac-8)", async () => {
    tagAc(AC8);
    tagAc(AC2);
    const ids = (await listHomeSpecs(owner)).map((c) => c.docId);
    expect(ids).toContain(idCreated);
    expect(ids).toContain(idAssigned);
    expect(ids).toContain(idActed);
    expect(ids).toContain(idDemo); // demo no longer hidden
    expect(ids).toContain(idB); // cross-memex
    expect(ids).not.toContain(idStaleActed); // >90d, not created/assigned
    expect(ids).not.toContain(idOther); // never mine
    expect(ids).not.toContain(idC); // not a member of memex C
  });

  it("tiers assigned-to-me above my own work, each by my last activity desc (ac-8)", async () => {
    tagAc(AC8);
    const res = await listHomeSpecs(owner);
    // assigned floats to the top even though acted/created are more recent
    expect(res[0].docId).toBe(idAssigned);
    expect(res[0].tier).toBe("assigned");
    // the 'mine' tier follows, ordered by MY last activity desc: acted(1d) > created(2d) > demo(3d) > B(4d)
    const mineOrder = res.filter((c) => c.tier === "mine").map((c) => c.docId);
    expect(mineOrder).toEqual([idActed, idCreated, idDemo, idB]);
  });

  it("carries Pulse-card data + provenance per spec (ac-2)", async () => {
    tagAc(AC2);
    const card = (await listHomeSpecs(owner)).find((c) => c.docId === idActed)!;
    expect(typeof card.phase).toBe("string");
    expect(card.phase.length).toBeGreaterThan(0); // documents.status drives the phase chip
    expect(card.narrative).toBeTruthy(); // latest activity narrative on the spec
    expect(card.spark.length).toBe(14);
    expect(card.namespaceSlug).toBeTruthy();
    expect(card.path).toMatch(/^\/[^/]+\/main\/specs\/spec-\d+$/);
    expect(card.lastActivityMineMs).toBeGreaterThan(0);
  });
});
