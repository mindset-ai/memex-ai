// spec-156 W3 ac-22 — createMemex must emit memex/created on the unified bus.
//
// The widened static scan (mutate-coverage.static-scan.test.ts) surfaced
// services/memexes.ts createMemex as a raw db.insert(memexes) outside mutate():
// a Memex is a tenant entity, and the personal-memex path in
// services/user-namespaces.ts already emits memex/created. This proves the
// remediation: createMemex now routes through mutate() and emits the event keyed
// on the freshly-created memex with the caller's userId (so the right session's
// /api/me/events stream wakes).
//
// Tagged (tagAc) → reports to the PROD memex. Run with MEMEX_EMIT=false locally.

import { describe, it, expect, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import { createMemex } from "./memexes.js";
import { upsertUserByEmail } from "./users.js";
import { makeTestMemexWithDevAdmin } from "./test-helpers.js";
import { bus, type ChangeEvent } from "./bus.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-156/acs";

const createdMemexIds: string[] = [];

afterAll(async () => {
  if (createdMemexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  }
});

describe("spec-156 ac-22: createMemex emits memex/created (std-8 hole closed)", () => {
  it("routes the insert through mutate() and emits memex/created for the caller", async () => {
    tagAc(`${AC}/ac-22`);
    // Seed an org namespace with the dev user as an active admin so createMemex's
    // membership check passes.
    const seed = await makeTestMemexWithDevAdmin("s156ac22");
    const seedMemex = await db.query.memexes.findFirst({
      where: eq(memexes.id, seed.memexId),
    });
    const namespaceId = seedMemex!.namespaceId;
    createdMemexIds.push(seed.memexId);
    const dev = await upsertUserByEmail("dev@memex.ai");

    const events: ChangeEvent[] = [];
    const unsub = bus.subscribe({}, (e) => events.push(e));
    let newMemexId: string;
    try {
      const created = await createMemex({
        namespaceId,
        slug: `child-${Date.now().toString(36)}`,
        callerUserId: dev.id,
      });
      newMemexId = created.id;
      createdMemexIds.push(created.id);
    } finally {
      unsub();
    }

    const emitted = events.filter(
      (e) =>
        e.memexId === newMemexId &&
        e.entity === "memex" &&
        e.action === "created",
    );
    expect(emitted).toHaveLength(1);
    // Keyed with the caller's userId so the per-session /api/me/events stream wakes.
    expect(emitted[0].userId).toBe(dev.id);
  });
});
