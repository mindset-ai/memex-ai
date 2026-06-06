// Integration tests for b-68 t-11 — short-cache + std-8 bus invalidation for
// per-Org scaffold additions.
//
// All three tests tag `ac-10`: "Org blocks are short-cached; the std-8 bus
// event from an admin edit invalidates the cache so subsequent tool calls see
// the new content without a process restart."
//
//   1. **Cache hit**: two rapid-fire reads issue exactly one underlying DB
//      call.
//   2. **TTL expiry**: advancing fake time past TTL triggers a second DB call.
//   3. **Bus invalidation**: a `createOrgScaffoldAddition` emits on the std-8
//      bus; the next cached read sees the new block without waiting on TTL.
//
// The first two assert the cache exists and respects its TTL; the third
// asserts the invariant that admin edits become visible without a process
// restart — the load-bearing AC behaviour.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { namespaces, orgs, memexes } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import {
  createOrgScaffoldAddition,
} from "./scaffold-additions.js";
import {
  _expireAllScaffoldAdditionsCacheEntries,
  _getUnderlyingReadCount,
  _resetScaffoldAdditionsCache,
  _stopScaffoldAdditionsCacheInvalidation,
  listOrgScaffoldAdditionsCached,
  startScaffoldAdditionsCacheInvalidation,
} from "./scaffold-additions-cache.js";

const AC_10 = "mindset-prod/memex-building-itself/briefs/b-68/acs/ac-10";

interface TestOrg {
  orgId: string;
  namespaceId: string;
  memexId: string;
  authorId: string;
}

async function makeTestOrg(prefix: string): Promise<TestOrg> {
  const slug = `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`
    .toLowerCase()
    .slice(0, 39);
  const result = await db.transaction(async (tx) => {
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "org" })
      .returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Test ${prefix}` })
      .returning();
    await tx
      .update(namespaces)
      .set({ ownerOrgId: org.id })
      .where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    return { ns, org, memex };
  });
  const user = await upsertUserByEmail(`scaffold-cache-${slug}@memex.test`);
  return {
    orgId: result.org.id,
    namespaceId: result.ns.id,
    memexId: result.memex.id,
    authorId: user.id,
  };
}

const createdNamespaceIds: string[] = [];

afterAll(async () => {
  for (const nsId of createdNamespaceIds) {
    // Namespace cascade nukes org → memex → org_scaffold_additions.
    await db.delete(namespaces).where(eq(namespaces.id, nsId)).catch(() => {});
  }
});

// The bus subscriber is normally armed by `index.ts` at process startup.
// Vitest doesn't boot the HTTP server, so we arm it manually here. The latch
// inside `startScaffoldAdditionsCacheInvalidation` makes the call idempotent.
beforeAll(() => {
  startScaffoldAdditionsCacheInvalidation();
});

afterAll(() => {
  _stopScaffoldAdditionsCacheInvalidation();
});

beforeEach(() => {
  _resetScaffoldAdditionsCache();
});

describe("scaffold-additions-cache (b-68 ac-10)", () => {
  it("cache hit: two rapid reads issue exactly one underlying read", async () => {
    tagAc(AC_10);
    const fx = await makeTestOrg("hit");
    createdNamespaceIds.push(fx.namespaceId);

    // Seed one row so the response is non-empty and we can verify content
    // identity across calls.
    await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { phase: "specify" },
      text: "cache-hit-block",
      rationale: "first block",
    });

    const before = _getUnderlyingReadCount();
    const first = await listOrgScaffoldAdditionsCached(fx.orgId, { enabledOnly: true });
    const after1 = _getUnderlyingReadCount();
    const second = await listOrgScaffoldAdditionsCached(fx.orgId, { enabledOnly: true });
    const after2 = _getUnderlyingReadCount();

    expect(after1 - before).toBe(1);
    expect(after2 - after1).toBe(0); // second call served from cache
    expect(first).toEqual(second);
    expect(first.map((b) => b.text)).toEqual(["cache-hit-block"]);
  });

  it("TTL expiry: an expired entry forces a fresh underlying read", async () => {
    tagAc(AC_10);
    const fx = await makeTestOrg("ttl");
    createdNamespaceIds.push(fx.namespaceId);

    await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { phase: "specify" },
      text: "ttl-block",
      rationale: "ttl rationale",
    });

    // Prime + assert: one read for the first call.
    const before = _getUnderlyingReadCount();
    await listOrgScaffoldAdditionsCached(fx.orgId, { enabledOnly: true });
    expect(_getUnderlyingReadCount() - before).toBe(1);

    // Second call within TTL: still served from cache.
    await listOrgScaffoldAdditionsCached(fx.orgId, { enabledOnly: true });
    expect(_getUnderlyingReadCount() - before).toBe(1);

    // Force every cached entry into the expired state. Equivalent to advancing
    // real time past the TTL but without `vi.useFakeTimers`, which deadlocks
    // the real DB driver (it relies on setTimeout/setImmediate for connection
    // I/O). This is the same property the production TTL gate checks —
    // `expiresAt > Date.now()` — just driven directly from the test.
    _expireAllScaffoldAdditionsCacheEntries();

    // Third call after expiry: refresh from source.
    await listOrgScaffoldAdditionsCached(fx.orgId, { enabledOnly: true });
    expect(_getUnderlyingReadCount() - before).toBe(2);
  });

  it("bus invalidation: a create event makes the next cached read see the new block", async () => {
    tagAc(AC_10);
    const fx = await makeTestOrg("bus");
    createdNamespaceIds.push(fx.namespaceId);

    // Prime the cache while the org has zero additions.
    const empty = await listOrgScaffoldAdditionsCached(fx.orgId, { enabledOnly: true });
    expect(empty).toEqual([]);

    // Confirm the cache served the empty result on a subsequent call (no
    // extra DB reads). If we don't pin this, we can't distinguish "bus
    // invalidated" from "TTL expired" / "never cached" on the next assertion.
    const beforeWrite = _getUnderlyingReadCount();
    await listOrgScaffoldAdditionsCached(fx.orgId, { enabledOnly: true });
    expect(_getUnderlyingReadCount() - beforeWrite).toBe(0);

    // Admin edit lands. The mutate() wrapper emits an `org_scaffold_addition`
    // event synchronously after the DB write; our subscriber kicks off an
    // async `orgIdForMemex` lookup and then invalidates. We need to wait for
    // that detached promise — drain the microtask queue + give the lookup
    // round-trip time.
    await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { phase: "specify" },
      text: "post-bus-block",
      rationale: "appears after bus event",
    });

    // Yield the event loop until the cache slot for this org is gone. 200ms
    // is generous — the in-process lookup is sub-ms in practice. Falls back
    // to the assertion below if invalidation never lands.
    await waitForCacheMiss(fx.orgId);

    // Subsequent cached read must see the new block. No TTL advance — purely
    // bus-driven. This is the load-bearing AC-10 assertion.
    const afterReadCount = _getUnderlyingReadCount();
    const refreshed = await listOrgScaffoldAdditionsCached(fx.orgId, { enabledOnly: true });
    expect(_getUnderlyingReadCount() - afterReadCount).toBe(1);
    expect(refreshed.map((b) => b.text)).toEqual(["post-bus-block"]);
  });
});

// Spin until a fresh read happens (i.e. the cache slot is gone) or we run out
// of patience. Detects invalidation indirectly: if a cached read no longer
// charges the counter as a hit, the cache must have been cleared. Bounded by
// ~200ms in 10ms slices to keep test runtime tight.
async function waitForCacheMiss(orgId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const before = _getUnderlyingReadCount();
    await listOrgScaffoldAdditionsCached(orgId, { enabledOnly: true });
    const after = _getUnderlyingReadCount();
    if (after > before) {
      // It was a miss — cache had been invalidated. Reset so the test body's
      // own assertion can re-measure cleanly.
      _resetScaffoldAdditionsCache();
      return;
    }
    // Still a hit — give the bus subscriber's detached invalidation more time.
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `waitForCacheMiss: cache for org ${orgId} was still hot after 200ms — ` +
      `bus invalidation did not land`,
  );
}
