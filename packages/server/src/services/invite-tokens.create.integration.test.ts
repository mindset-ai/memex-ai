import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, inviteTokens } from "../db/schema.js";
import {
  createInviteToken,
  listActiveInvitesForAccount,
  revokeInviteToken,
} from "./invite-tokens.js";

const createdAccountIds: string[] = [];
const createdInviteIds: string[] = [];

afterAll(async () => {
  if (createdInviteIds.length) {
    await db.delete(inviteTokens).where(inArray(inviteTokens.id, createdInviteIds)).catch(() => {});
  }
  if (createdAccountIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdAccountIds)).catch(() => {});
  }
});

function uniqueSubdomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

// Returns org.id (invite-tokens key on org_id post-doc-15).
async function makeAccount(): Promise<string> {
  const sub = uniqueSubdomain("ic");
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Inv Create Test" }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [acct] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Inv Create Test" }).returning();
  createdAccountIds.push(acct.id);
  return org.id;
}

describe("createInviteToken", () => {
  it("creates a token with 7-day expiration", async () => {
    const memexId = await makeAccount();
    const before = Date.now();
    const invite = await createInviteToken(memexId);
    createdInviteIds.push(invite.id);

    expect(invite.orgId).toBe(memexId);
    expect(invite.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(invite.revokedAt).toBeNull();

    const ttlMs = invite.expiresAt.getTime() - before;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // Allow 5s drift for clock + DB round-trip
    expect(ttlMs).toBeGreaterThanOrEqual(sevenDaysMs - 5000);
    expect(ttlMs).toBeLessThanOrEqual(sevenDaysMs + 5000);
  });

  it("generates unique tokens across calls", async () => {
    const memexId = await makeAccount();
    const a = await createInviteToken(memexId);
    const b = await createInviteToken(memexId);
    createdInviteIds.push(a.id, b.id);
    expect(a.token).not.toBe(b.token);
  });
});

describe("listActiveInvitesForAccount", () => {
  it("returns only unrevoked, unexpired invites for the requested account", async () => {
    const accountA = await makeAccount();
    const accountB = await makeAccount();

    // Three tokens on A: active, revoked, expired
    const active = await createInviteToken(accountA);
    const revoked = await createInviteToken(accountA);
    const expired = await createInviteToken(accountA);
    createdInviteIds.push(active.id, revoked.id, expired.id);
    await db
      .update(inviteTokens)
      .set({ revokedAt: new Date() })
      .where(eq(inviteTokens.id, revoked.id));
    await db
      .update(inviteTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(inviteTokens.id, expired.id));

    // One on B (should not appear)
    const otherAccount = await createInviteToken(accountB);
    createdInviteIds.push(otherAccount.id);

    const list = await listActiveInvitesForAccount(accountA);
    expect(list.map((i) => i.id)).toEqual([active.id]);
  });

  it("returns invites newest-first", async () => {
    const memexId = await makeAccount();
    const first = await createInviteToken(memexId);
    await new Promise((r) => setTimeout(r, 5));
    const second = await createInviteToken(memexId);
    createdInviteIds.push(first.id, second.id);

    const list = await listActiveInvitesForAccount(memexId);
    expect(list[0].id).toBe(second.id);
    expect(list[1].id).toBe(first.id);
  });
});

describe("revokeInviteToken", () => {
  it("stamps revokedAt on an active invite", async () => {
    const memexId = await makeAccount();
    const invite = await createInviteToken(memexId);
    createdInviteIds.push(invite.id);

    const result = await revokeInviteToken(invite.id, memexId);
    expect(result?.revokedAt).toBeInstanceOf(Date);
  });

  it("is idempotent for already-revoked invites", async () => {
    const memexId = await makeAccount();
    const invite = await createInviteToken(memexId);
    createdInviteIds.push(invite.id);

    const first = await revokeInviteToken(invite.id, memexId);
    const second = await revokeInviteToken(invite.id, memexId);
    expect(second?.revokedAt?.getTime()).toBe(first?.revokedAt?.getTime());
  });

  it("returns null for invites that don't belong to the account", async () => {
    const accountA = await makeAccount();
    const accountB = await makeAccount();
    const invite = await createInviteToken(accountA);
    createdInviteIds.push(invite.id);

    const result = await revokeInviteToken(invite.id, accountB);
    expect(result).toBeNull();
  });

  it("returns null for unknown invite ids", async () => {
    const memexId = await makeAccount();
    const result = await revokeInviteToken(
      "00000000-0000-0000-0000-000000000000",
      memexId
    );
    expect(result).toBeNull();
  });
});

// Expired-invite retention (regression): expired tokens are NOT purged, so an
// expired link stays distinguishable from an invalid one. The deletion-based
// `cleanupExpiredInviteTokens` was removed — see invite-tokens.ts. The
// behavioural assertion (expired → reason:"expired") lives in
// invite-tokens.edge.integration.test.ts.
describe("expired invites are retained (no purge)", () => {
  it("keeps an expired, non-revoked invite row in the table", async () => {
    const memexId = await makeAccount();
    const expired = await createInviteToken(memexId);
    createdInviteIds.push(expired.id);

    await db
      .update(inviteTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(inviteTokens.id, expired.id));

    // No housekeeping job deletes it; the row persists indefinitely.
    const survivor = await db.query.inviteTokens.findFirst({
      where: eq(inviteTokens.id, expired.id),
    });
    expect(survivor).toBeTruthy();
    expect(survivor?.revokedAt).toBeNull();
  });
});
