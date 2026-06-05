import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, users } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { createInviteToken } from "../services/invite-tokens.js";
import { createShareToken } from "../services/share-tokens.js";
import { createDomainVerificationToken } from "../services/domain-verification.js";
import { createDocDraft } from "../services/documents.js";

// Resolve the org id (FK target for invite + domain-verification tokens) from a
// freshly-created test memex. doc-15 split: invites/domain verification anchor
// to the org row, not the memex.
async function orgIdForMemex(memexId: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId));
  if (!row?.orgId) throw new Error(`No org for memex ${memexId}`);
  return row.orgId;
}

const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
});

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

// Matches Node's `crypto.randomUUID()` output — 36 chars with hyphens, version nibble 4.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("security: token entropy & replay", () => {
  it("invite, share, and domain-verification tokens are UUID v4 (~122 bits of entropy)", async () => {
    const memexId = await makeTestMemex("tok-ent");
    memexIds.push(memexId);
    const orgId = await orgIdForMemex(memexId);
    const dev = await upsertUserByEmail("dev@memex.ai");
    userIds.push(dev.id);

    void memexes;

    // doc-15: domain-verification tokens are anchored to the org and require
    // the domain to be in the org's claimed-domains list before a token is
    // minted (precondition added with the namespace/org/memex split).
    const { orgs } = await import("../db/schema.js");
    await db
      .update(orgs)
      .set({ emailDomains: ["example.com"] })
      .where(eq(orgs.id, orgId));

    const doc = await createDocDraft(memexId, "Tokens Test", "purpose");

    const invite = await createInviteToken(orgId);
    const share = await createShareToken(memexId, doc.id);
    const dv = await createDomainVerificationToken(orgId, "example.com");

    expect(invite.token).toMatch(UUID_V4_RE);
    expect(share.token).toMatch(UUID_V4_RE);
    expect(dv.token).toMatch(UUID_V4_RE);
    // Sanity: tokens are mutually distinct — no seed-collision in the RNG.
    expect(new Set([invite.token, share.token, dv.token]).size).toBe(3);
  });

  it("replaying an unknown (never-issued) share token returns 404, not a generic server error", async () => {
    // Brute-force probing must not succeed and must not reveal whether a token was once valid.
    const res = await app.request(`/api/share/00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe("unknown");
  });

  it("revoked share token replay returns 410 Gone (not 200), closing the replay window", async () => {
    const memexId = await makeTestMemex("tok-rev");
    memexIds.push(memexId);
    const dev = await upsertUserByEmail("dev@memex.ai");
    userIds.push(dev.id);

    const doc = await createDocDraft(memexId, "Revoked Test", "purpose");
    const tok = await createShareToken(memexId, doc.id);

    const { revokeShareToken } = await import("../services/share-tokens.js");
    await revokeShareToken(memexId, tok.id);

    const res = await app.request(`/api/share/${tok.token}`);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.reason).toBe("revoked");
  });

  it("revoked invite token cannot be claimed by any user", async () => {
    // Multi-use invites stay valid until revoked or expired. Once an admin revokes a link,
    // further claims must fail for EVERY user — the link is dead across the board.
    const memexId = await makeTestMemex("tok-rev-inv");
    memexIds.push(memexId);
    const orgId = await orgIdForMemex(memexId);

    const invite = await createInviteToken(orgId);

    const u1 = await upsertUserByEmail("claim-a@example.com");
    const u2 = await upsertUserByEmail("claim-b@example.com");
    userIds.push(u1.id, u2.id);

    const { consumeInviteToken, revokeInviteToken, InviteTokenError } = await import(
      "../services/invite-tokens.js"
    );

    // First user joins — link still valid.
    const first = await consumeInviteToken(invite.token, u1.id);
    expect(first.userId).toBe(u1.id);

    // Admin revokes the link.
    await revokeInviteToken(invite.id, orgId);

    // A different user attempting the same (now-revoked) token is rejected.
    await expect(consumeInviteToken(invite.token, u2.id)).rejects.toMatchObject({
      name: "InviteTokenError",
      reason: "revoked",
    });
    // Reference ensures the import isn't tree-shaken if we change the code later.
    void InviteTokenError;
  });
});
