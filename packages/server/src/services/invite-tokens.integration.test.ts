import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, inviteTokens, users } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import { consumeInviteToken } from "./invite-tokens.js";

const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];
const createdInviteIds: string[] = [];

afterAll(async () => {
  if (createdInviteIds.length) {
    await db.delete(inviteTokens).where(inArray(inviteTokens.id, createdInviteIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdAccountIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdAccountIds)).catch(() => {});
  }
});

function uniqueSubdomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function uniqueToken(): string {
  return `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// Returns the org.id (the legacy "memexId" arg in invite-tokens contexts is
// the org.id post-doc-15).
async function makeAccount(name = "Inv Test"): Promise<string> {
  const sub = uniqueSubdomain("inv");
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [acct] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name }).returning();
  createdAccountIds.push(acct.id);
  return org.id;
}

async function makeInvite(memexId: string, opts?: { revokedAt?: Date; expiresAt?: Date }) {
  const [invite] = await db
    .insert(inviteTokens)
    .values({
      orgId: memexId,
      token: uniqueToken(),
      revokedAt: opts?.revokedAt ?? null,
      expiresAt: opts?.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning();
  createdInviteIds.push(invite.id);
  return invite;
}

// Re-enabled after t-16 of doc-15: consumeInviteToken now inserts role='member'
// (matching the new check constraint). Source-fix landed; unskipping.
describe("consumeInviteToken — happy path", () => {
  it("creates a 'user' membership without marking the token revoked", async () => {
    const memexId = await makeAccount();
    const user = await upsertUserByEmail(uniqueEmail("invuser"));
    createdUserIds.push(user.id);

    const invite = await makeInvite(memexId);
    const membership = await consumeInviteToken(invite.token, user.id);

    expect(membership.userId).toBe(user.id);
    expect(membership.orgId).toBe(memexId);
    expect(membership.role).toBe("member");

    // Multi-use: the link stays valid after a successful join.
    const reloaded = await db.query.inviteTokens.findFirst({
      where: eq(inviteTokens.id, invite.id),
    });
    expect(reloaded?.revokedAt).toBeNull();
  });
});

describe("consumeInviteToken — error cases", () => {
  it("rejects unknown tokens", async () => {
    const user = await upsertUserByEmail(uniqueEmail("unk"));
    createdUserIds.push(user.id);

    await expect(consumeInviteToken("does-not-exist", user.id))
      .rejects.toMatchObject({ name: "InviteTokenError", reason: "unknown" });
  });

  it("rejects revoked tokens", async () => {
    const memexId = await makeAccount();
    const user = await upsertUserByEmail(uniqueEmail("revu"));
    createdUserIds.push(user.id);

    const invite = await makeInvite(memexId, { revokedAt: new Date() });
    await expect(consumeInviteToken(invite.token, user.id))
      .rejects.toMatchObject({ name: "InviteTokenError", reason: "revoked" });
  });

  it("rejects expired tokens", async () => {
    const memexId = await makeAccount();
    const user = await upsertUserByEmail(uniqueEmail("expu"));
    createdUserIds.push(user.id);

    const invite = await makeInvite(memexId, {
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(consumeInviteToken(invite.token, user.id))
      .rejects.toMatchObject({ name: "InviteTokenError", reason: "expired" });
  });
});

describe("consumeInviteToken — idempotency", () => {
  it("returns existing membership when user is already in the account", async () => {
    const memexId = await makeAccount();
    const user = await upsertUserByEmail(uniqueEmail("idem"));
    createdUserIds.push(user.id);

    // Pre-existing membership (e.g., user joined earlier via a different invite)
    const [existing] = await db
      .insert(orgMemberships)
      .values({ orgId: memexId, userId: user.id, role: "administrator" })
      .returning();

    const invite = await makeInvite(memexId);
    const membership = await consumeInviteToken(invite.token, user.id);

    expect(membership.id).toBe(existing.id);
    expect(membership.role).toBe("administrator");

    // Link remains active — other teammates can still join.
    const reloaded = await db.query.inviteTokens.findFirst({
      where: eq(inviteTokens.id, invite.id),
    });
    expect(reloaded?.revokedAt).toBeNull();
  });
});

describe("consumeInviteToken — multi-use", () => {
  it("lets two different users claim the same link", async () => {
    const memexId = await makeAccount();
    const userA = await upsertUserByEmail(uniqueEmail("ma"));
    const userB = await upsertUserByEmail(uniqueEmail("mb"));
    createdUserIds.push(userA.id, userB.id);

    const invite = await makeInvite(memexId);

    const membershipA = await consumeInviteToken(invite.token, userA.id);
    const membershipB = await consumeInviteToken(invite.token, userB.id);

    expect(membershipA.userId).toBe(userA.id);
    expect(membershipB.userId).toBe(userB.id);
    expect(membershipA.orgId).toBe(memexId);
    expect(membershipB.orgId).toBe(memexId);
  });
});
