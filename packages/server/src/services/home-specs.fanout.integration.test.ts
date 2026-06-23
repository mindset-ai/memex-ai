// spec-353 (perf-2) + spec-352 (perf-1) — the cross-Memex Home fan-out now runs
// the per-Memex blocks in bounded-parallel batches (MEMEX_CONCURRENCY) instead of
// a serial for...await loop. These tests pin the two invariants the refactor must
// preserve:
//   (a) IDENTICAL results — a user in many Memexes gets exactly the cards they'd
//       get serially, in the same sort-determined order.
//   (b) TENANT ISOLATION across the parallel batches — each per-Memex block runs
//       in its own runWithMemexId ALS subtree, so racing them must NOT bleed one
//       tenant's specs into another's card set (std-36). We deliberately span more
//       than MEMEX_CONCURRENCY (4) Memexes so at least one full parallel batch +
//       a partial batch execute.
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  activityLog,
  memexes,
  namespaces,
  orgMemberships,
  orgs,
} from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { listHomeSpecs } from "./home-specs.js";

const rand = () => Math.random().toString(36).slice(2, 8);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
let slugSeq = 0;
const uniqueSlug = (p: string) =>
  `${p}-${Date.now().toString(36)}-${(slugSeq += 1)}-${rand()}`.slice(0, 39);

async function makeMemex(prefix: string, adminUserId: string): Promise<{ memexId: string; slug: string }> {
  const slug = uniqueSlug(prefix);
  const { ns, org, memex } = await db.transaction(async (tx) => {
    const [ns] = await tx.insert(namespaces).values({ slug, kind: "org" }).returning();
    const [org] = await tx.insert(orgs).values({ namespaceId: ns.id, name: `Test ${prefix}` }).returning();
    await tx.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    const [memex] = await tx.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
    return { ns, org, memex };
  });
  await db
    .insert(orgMemberships)
    .values({ userId: adminUserId, orgId: org.id, role: "administrator" })
    .onConflictDoNothing();
  return { memexId: memex.id, slug: ns.slug };
}

async function mkSpec(memexId: string, title: string, createdBy: string) {
  return createDocDraft(memexId, title, "purpose", "spec", undefined, undefined, createdBy);
}
async function seedActivity(memexId: string, briefId: string, actorUserId: string, at: Date) {
  await db.insert(activityLog).values({
    memexId, briefId, actorUserId, actorKind: "human", channel: "rest_ui",
    entity: "decision", action: "created", narrative: "acted", createdAt: at,
  });
}

describe("listHomeSpecs cross-Memex fan-out (spec-353)", () => {
  let owner: string;
  const N = 7; // > MEMEX_CONCURRENCY (4): forces a full batch + a partial batch
  const specIdByMemex: { memexId: string; specId: string; ageDays: number }[] = [];

  beforeAll(async () => {
    owner = (await upsertUserByEmail(`fanout-owner-${Date.now()}-${rand()}@example.com`)).id;
    const alice = (await upsertUserByEmail(`fanout-alice-${Date.now()}-${rand()}@example.com`)).id;
    for (let i = 0; i < N; i++) {
      const m = await makeMemex(`fo-${i}`, owner);
      // exactly one qualifying spec per Memex: created by alice, acted on by owner.
      const spec = await mkSpec(m.memexId, `Fanout spec ${i}`, alice);
      const ageDays = i + 1; // distinct ages → deterministic ordering
      await seedActivity(m.memexId, spec.id, owner, daysAgo(ageDays));
      specIdByMemex.push({ memexId: m.memexId, specId: spec.id, ageDays });
    }
  });

  it("returns exactly one card per member Memex — no tenant bleed across parallel batches", async () => {
    const cards = await listHomeSpecs(owner);
    const mine = cards.filter((c) => specIdByMemex.some((s) => s.specId === c.docId));
    // every seeded spec appears exactly once
    expect(mine.length).toBe(N);
    expect(new Set(mine.map((c) => c.docId)).size).toBe(N);
    // ISOLATION: each card's memexId is the SAME tenant that owns its spec — the
    // parallel runWithMemexId subtrees never crossed streams.
    for (const card of mine) {
      const expected = specIdByMemex.find((s) => s.specId === card.docId)!;
      expect(card.memexId).toBe(expected.memexId);
    }
    // every card carries the correct provenance path for its own tenant
    for (const card of mine) {
      expect(card.path).toBe(`/${card.namespaceSlug}/${card.memexSlug}/specs/${card.handle}`);
    }
  });

  it("orders the 'mine' tier by MY last activity desc — deterministic regardless of batch interleaving", async () => {
    const cards = await listHomeSpecs(owner);
    const mineOrder = cards
      .filter((c) => specIdByMemex.some((s) => s.specId === c.docId))
      .map((c) => c.docId);
    // ages 1..N days → newest (1d) first. Sort is by lastActivityMineMs desc.
    const expectedOrder = [...specIdByMemex].sort((a, b) => a.ageDays - b.ageDays).map((s) => s.specId);
    expect(mineOrder).toEqual(expectedOrder);
  });

  it("is stable across repeated calls (parallel fan-out is order-deterministic)", async () => {
    const a = (await listHomeSpecs(owner)).map((c) => c.docId);
    const b = (await listHomeSpecs(owner)).map((c) => c.docId);
    expect(a).toEqual(b);
  });
});
