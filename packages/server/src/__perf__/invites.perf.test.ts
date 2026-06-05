import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, users } from "../db/schema.js";
import { createInviteToken, consumeInviteToken } from "../services/invite-tokens.js";
import { upsertUserByEmail } from "../services/users.js";
import { makeTestMemex } from "../services/test-helpers.js";

const memexIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  if (memexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
  }
  if (userIds.length) {
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {});
  }
});

async function orgIdForMemex(memexId: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId));
  if (!row?.orgId) throw new Error(`No org for memex ${memexId}`);
  return row.orgId;
}

describe("perf: invite tokens under concurrency", () => {
  it("20 admins generating invites concurrently all receive unique tokens", async () => {
    const N = 20;
    const accts = await Promise.all(
      Array.from({ length: N }, (_, i) => makeTestMemex(`pi${i}`))
    );
    memexIds.push(...accts);
    // doc-15 t-11: invite tokens anchor to orgs, not memexes. Resolve the
    // org id for each test memex.
    const orgIds = await Promise.all(accts.map(orgIdForMemex));

    const invites = await Promise.all(orgIds.map((id) => createInviteToken(id)));
    const tokens = invites.map((inv) => inv.token);

    // Every token is non-empty and globally unique.
    expect(tokens).toHaveLength(N);
    expect(new Set(tokens).size).toBe(N);
    for (const t of tokens) {
      expect(t).toMatch(/^[0-9a-f-]{36}$/);
    }
  }, 20_000);

  it("10 users clicking the same invite token concurrently: all succeed (multi-use)", async () => {
    const memexId = await makeTestMemex("pi-race");
    memexIds.push(memexId);
    const orgId = await orgIdForMemex(memexId);
    const invite = await createInviteToken(orgId);

    const N = 10;
    const claimants = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        upsertUserByEmail(`pi-claim-${Date.now().toString(36)}-${i}@perf.test`)
      )
    );
    userIds.push(...claimants.map((u) => u.id));

    const results = await Promise.allSettled(
      claimants.map((u) => consumeInviteToken(invite.token, u.id))
    );

    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes).toHaveLength(N);
  }, 20_000);
});
