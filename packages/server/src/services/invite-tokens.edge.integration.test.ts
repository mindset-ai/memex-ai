import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, inviteTokens } from "../db/schema.js";
import {
  createInviteToken,
  consumeInviteToken,
  revokeInviteToken,
  InviteTokenError,
} from "./invite-tokens.js";
import { upsertUserByEmail } from "./users.js";

// Local fixture: invite-tokens key on org_id, so this test needs the org id —
// not the memex id that makeTestMemex returns. Build the namespace+org+memex
// tuple inline.
async function makeTestMemex(prefix: string): Promise<string> {
  const slug = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase().slice(0, 39);
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${prefix}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" });
  return org.id;
}

// t-14: deferred edge-case tests for invite token expiration and cleanup job.
//   - 7-day boundary: token still valid at +7d-1ms, invalid at +7d+1ms
//   - Cleanup idempotency: running twice is a no-op the second time
//   - Concurrent cleanup: simulate two instances running at once — no crash, no double-delete

const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdAccountIds)).catch(() => {});
  }
  if (createdAccountIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdAccountIds)).catch(() => {});
  }
});

describe("Invite token 7-day expiration boundary (t-14)", () => {
  it("rejects a token with expiresAt in the past (just 1ms ago)", async () => {
    const memexId = await makeTestMemex("boundary");
    createdAccountIds.push(memexId);
    const invite = await createInviteToken(memexId);
    // Backdate so expiresAt is 1ms in the past
    await db
      .update(inviteTokens)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(inviteTokens.id, invite.id));

    const user = await upsertUserByEmail(`edge-${Date.now()}@example.com`);
    createdUserIds.push(user.id);

    await expect(consumeInviteToken(invite.token, user.id))
      .rejects.toMatchObject({ name: "InviteTokenError", reason: "expired" });
  });

  it("accepts a token with expiresAt exactly now + 1s (still valid)", async () => {
    const memexId = await makeTestMemex("valid");
    createdAccountIds.push(memexId);
    const invite = await createInviteToken(memexId);
    await db
      .update(inviteTokens)
      .set({ expiresAt: new Date(Date.now() + 1000) })
      .where(eq(inviteTokens.id, invite.id));

    const user = await upsertUserByEmail(`valid-${Date.now()}@example.com`);
    createdUserIds.push(user.id);

    const membership = await consumeInviteToken(invite.token, user.id);
    expect(membership.orgId).toBe(memexId);
  });
});

// Regression (expired-invite UX): an expired invite link must report "expired",
// not the generic "unknown"/invalid message. The bug was that an hourly job
// hard-deleted expired rows, so by the time a user clicked an old link the row
// was gone and consumeInviteToken fell into the "unknown" branch. The purge was
// removed; these tests lock the fix. They would FAIL against the old
// delete-by-expiry behaviour (the row would be gone → reason "unknown").
describe("expired invites stay reportable (no purge) — regression", () => {
  it("reports reason 'expired' for a long-expired, non-revoked invite", async () => {
    const memexId = await makeTestMemex("retain-exp");
    createdAccountIds.push(memexId);
    const invite = await createInviteToken(memexId);
    // Backdate well past the 7-day TTL — the kind of link that the old hourly
    // sweep would have deleted hours/days ago.
    await db
      .update(inviteTokens)
      .set({ expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })
      .where(eq(inviteTokens.id, invite.id));

    const user = await upsertUserByEmail(`retain-${Date.now()}@example.com`);
    createdUserIds.push(user.id);

    await expect(consumeInviteToken(invite.token, user.id))
      .rejects.toMatchObject({ name: "InviteTokenError", reason: "expired" });

    // The row is retained — it is NOT silently garbage-collected.
    const survivor = await db.query.inviteTokens.findFirst({
      where: eq(inviteTokens.id, invite.id),
    });
    expect(survivor).toBeTruthy();
  });

  it("still reports 'unknown' for a genuinely non-existent token", async () => {
    const user = await upsertUserByEmail(`nf-${Date.now()}@example.com`);
    createdUserIds.push(user.id);
    await expect(consumeInviteToken("no-such-token", user.id))
      .rejects.toMatchObject({ name: "InviteTokenError", reason: "unknown" });
  });
});

describe("consumeInviteToken: revocation semantics", () => {
  it("revoking after a successful join stops subsequent teammates from claiming the link", async () => {
    const memexId = await makeTestMemex("revokeflag");
    createdAccountIds.push(memexId);
    const invite = await createInviteToken(memexId);

    const userA = await upsertUserByEmail(`ua-${Date.now()}@example.com`);
    const userB = await upsertUserByEmail(`ub-${Date.now()}@example.com`);
    createdUserIds.push(userA.id, userB.id);

    // First user joins — link stays valid.
    await consumeInviteToken(invite.token, userA.id);

    // Admin revokes the link.
    await revokeInviteToken(invite.id, memexId);

    // Second user is now rejected with reason "revoked".
    await expect(consumeInviteToken(invite.token, userB.id))
      .rejects.toBeInstanceOf(InviteTokenError);
    await expect(consumeInviteToken(invite.token, userB.id))
      .rejects.toMatchObject({ reason: "revoked" });
  });
});
