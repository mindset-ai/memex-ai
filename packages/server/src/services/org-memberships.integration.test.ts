import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, verifiedDomains, users, shareTokens } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import {
  joinByDomain,
  listDiscoverableOrgs,
  joinOrgByDomain,
} from "./org-discovery.js";
import { disableMembership } from "./org-memberships.js";
import { createDocDraft } from "./documents.js";
import { createShareToken, getSharedDocumentByToken, ShareTokenError } from "./share-tokens.js";
import { tagAc } from "@memex-ai-ac/vitest";
import { NotFoundError, ValidationError } from "../types/errors.js";

const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];
const createdDomains: string[] = [];

afterAll(async () => {
  if (createdDomains.length) {
    await db.delete(verifiedDomains).where(inArray(verifiedDomains.domain, createdDomains)).catch(() => {});
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

function uniqueDomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.test`;
}

// Returns the org.id (which `joinOrgByDomain` and `listDiscoverableOrgs`
// use as their identifier in the new namespace/org/memex world). The legacy
// "memexId" in this test maps to org.id, NOT memex.id.
async function makeAccount(opts: { autoGroupingEnabled: boolean }): Promise<string> {
  const sub = uniqueSubdomain("ag");
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: "AG Test", autoGroupingEnabled: opts.autoGroupingEnabled })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [acct] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: "AG Test" })
    .returning();
  createdAccountIds.push(acct.id);
  return org.id;
}

describe("joinByDomain", () => {
  it("creates a 'user' membership when verified domain matches an auto-grouping account", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: true });
    const domain = uniqueDomain("agok");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    const user = await upsertUserByEmail(`alice@${domain}`);
    createdUserIds.push(user.id);

    const membership = await joinByDomain(user.id, `alice@${domain}`);
    expect(membership).not.toBeNull();
    expect(membership?.orgId).toBe(memexId);
    expect(membership?.role).toBe("member");
  });

  it("returns null when the domain has no verified record", async () => {
    const user = await upsertUserByEmail(`bob@${uniqueDomain("nover")}`);
    createdUserIds.push(user.id);

    const result = await joinByDomain(user.id, user.email);
    expect(result).toBeNull();
  });

  it("returns null when the verified domain's account has auto-grouping disabled", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: false });
    const domain = uniqueDomain("agoff");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "email",
    } as any);

    const user = await upsertUserByEmail(`carol@${domain}`);
    createdUserIds.push(user.id);

    const result = await joinByDomain(user.id, `carol@${domain}`);
    expect(result).toBeNull();
  });

  it("returns null for malformed email", async () => {
    const user = await upsertUserByEmail(`dave-${Date.now()}@example.com`);
    createdUserIds.push(user.id);

    expect(await joinByDomain(user.id, "no-at-sign")).toBeNull();
    expect(await joinByDomain(user.id, "@empty-local-part")).toBeNull();
  });

  it("is idempotent: returns existing membership instead of inserting again", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: true });
    const domain = uniqueDomain("idem");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    const user = await upsertUserByEmail(`eve@${domain}`);
    createdUserIds.push(user.id);

    const first = await joinByDomain(user.id, `eve@${domain}`);
    const second = await joinByDomain(user.id, `eve@${domain}`);
    expect(second?.id).toBe(first?.id);

    // Verify there's only one membership row
    const rows = await db.query.orgMemberships.findMany({
      where: eq(orgMemberships.userId, user.id),
    });
    expect(rows).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Slack-style discovery + explicit join (the signup-flow pivot).
// ───────────────────────────────────────────────────────────────────────────────

describe("listDiscoverableOrgs", () => {
  it("returns [] when the email domain has no verified match", async () => {
    const user = await upsertUserByEmail(`disc1-${Date.now()}@nowhere-test.example`);
    createdUserIds.push(user.id);

    const list = await listDiscoverableOrgs(user.id, user.email);
    expect(list).toEqual([]);
  });

  it("returns the account when domain is verified + auto-grouping on + user is not a member", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: true });
    const domain = uniqueDomain("disc-ok");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    const user = await upsertUserByEmail(`new-user@${domain}`);
    createdUserIds.push(user.id);

    const list = await listDiscoverableOrgs(user.id, user.email);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(memexId);
  });

  it("excludes memexes whose auto-grouping is disabled", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: false });
    const domain = uniqueDomain("disc-off");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    const user = await upsertUserByEmail(`u@${domain}`);
    createdUserIds.push(user.id);

    const list = await listDiscoverableOrgs(user.id, user.email);
    expect(list).toEqual([]);
  });

  it("excludes memexes where the user is already an active member", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: true });
    const domain = uniqueDomain("disc-member");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    const user = await upsertUserByEmail(`already@${domain}`);
    createdUserIds.push(user.id);

    await db.insert(orgMemberships).values({
      userId: user.id,
      orgId: memexId,
      role: "member",
      status: "active",
    } as any);

    const list = await listDiscoverableOrgs(user.id, user.email);
    expect(list).toEqual([]);
  });

  it("still surfaces memexes where the user's membership is disabled (rejoin path)", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: true });
    const domain = uniqueDomain("disc-disabled");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    const user = await upsertUserByEmail(`kicked@${domain}`);
    createdUserIds.push(user.id);

    await db.insert(orgMemberships).values({
      userId: user.id,
      orgId: memexId,
      role: "member",
      status: "disabled",
    } as any);

    const list = await listDiscoverableOrgs(user.id, user.email);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(memexId);
  });

  it("returns [] when email is malformed", async () => {
    const user = await upsertUserByEmail(`malformed-${Date.now()}@example.com`);
    createdUserIds.push(user.id);

    expect(await listDiscoverableOrgs(user.id, "no-at-sign")).toEqual([]);
    expect(await listDiscoverableOrgs(user.id, "@leading")).toEqual([]);
  });
});

describe("joinOrgByDomain", () => {
  it("creates a 'user' membership when domain + auto-grouping match", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: true });
    const domain = uniqueDomain("join-ok");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    const user = await upsertUserByEmail(`joiner@${domain}`);
    createdUserIds.push(user.id);

    const membership = await joinOrgByDomain(user.id, user.email, memexId);
    expect(membership.orgId).toBe(memexId);
    expect(membership.role).toBe("member");
    expect(membership.status).toBe("active");
  });

  it("rejects when the account has auto-grouping disabled", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: false });
    const domain = uniqueDomain("join-off");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    const user = await upsertUserByEmail(`blocked@${domain}`);
    createdUserIds.push(user.id);

    await expect(
      joinOrgByDomain(user.id, user.email, memexId)
    ).rejects.toThrow(ValidationError);
  });

  it("rejects when the user's domain does not match a verified domain on the account", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: true });
    const claimedDomain = uniqueDomain("join-claimed");
    createdDomains.push(claimedDomain);
    await db.insert(verifiedDomains).values({
      domain: claimedDomain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    // User's domain is different from the verified one.
    const user = await upsertUserByEmail(`outsider-${Date.now()}@other-domain.example`);
    createdUserIds.push(user.id);

    await expect(
      joinOrgByDomain(user.id, user.email, memexId)
    ).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError when the account does not exist", async () => {
    const user = await upsertUserByEmail(`ghost-${Date.now()}@example.com`);
    createdUserIds.push(user.id);

    await expect(
      joinOrgByDomain(user.id, user.email, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });

  it("is idempotent for an already-active membership", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: true });
    const domain = uniqueDomain("join-idem");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    const user = await upsertUserByEmail(`idem@${domain}`);
    createdUserIds.push(user.id);

    const first = await joinOrgByDomain(user.id, user.email, memexId);
    const second = await joinOrgByDomain(user.id, user.email, memexId);
    expect(second.id).toBe(first.id);

    const rows = await db.query.orgMemberships.findMany({
      where: eq(orgMemberships.userId, user.id),
    });
    expect(rows).toHaveLength(1);
  });

  it("reactivates a disabled membership instead of creating a new row", async () => {
    const memexId = await makeAccount({ autoGroupingEnabled: true });
    const domain = uniqueDomain("join-react");
    createdDomains.push(domain);

    await db.insert(verifiedDomains).values({
      domain,
      orgId: memexId,
      verificationMethod: "sso",
    } as any);

    const user = await upsertUserByEmail(`react@${domain}`);
    createdUserIds.push(user.id);

    await db.insert(orgMemberships).values({
      userId: user.id,
      orgId: memexId,
      role: "member",
      status: "disabled",
    } as any);

    const membership = await joinOrgByDomain(user.id, user.email, memexId);
    expect(membership.status).toBe("active");

    const rows = await db.query.orgMemberships.findMany({
      where: eq(orgMemberships.userId, user.id),
    });
    expect(rows).toHaveLength(1);
  });
});

const AC_199 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-199/acs/ac-${n}`;

async function makeOrgWithMemex(): Promise<{ orgId: string; memexId: string }> {
  const sub = uniqueSubdomain("revoke");
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Revoke Org" }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [memex] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Revoke Memex" }).returning();
  createdAccountIds.push(memex.id);
  return { orgId: org.id, memexId: memex.id };
}

describe("spec-199 t-3 — disableMembership bulk-revokes share tokens (ac-10, ac-11)", () => {
  it("revoking a member revokes all their share tokens in the org in the same transaction (ac-10)", async () => {
    tagAc(AC_199(10));
    const { orgId, memexId } = await makeOrgWithMemex();

    const requester = await upsertUserByEmail(`requester-${Date.now()}@revoke.test`);
    const target = await upsertUserByEmail(`target-${Date.now()}@revoke.test`);
    createdUserIds.push(requester.id, target.id);

    await db.insert(orgMemberships).values([
      { userId: requester.id, orgId, role: "administrator", status: "active" },
      { userId: target.id, orgId, role: "member", status: "active" },
    ]);

    const doc = await createDocDraft(memexId, "Shared Doc", "purpose");
    const token = await createShareToken(memexId, doc.id, target.id);
    expect(token.revoked).toBe(false);

    await disableMembership(target.id, orgId, requester.id);

    const row = await db.query.shareTokens.findFirst({ where: eq(shareTokens.id, token.id) });
    expect(row?.revoked, "share token must be revoked after member removal").toBe(true);
  });

  it("revoked token returns ShareTokenError reason='revoked' after member removal (ac-11)", async () => {
    tagAc(AC_199(11));
    const { orgId, memexId } = await makeOrgWithMemex();

    const requester = await upsertUserByEmail(`req2-${Date.now()}@revoke.test`);
    const target = await upsertUserByEmail(`tgt2-${Date.now()}@revoke.test`);
    createdUserIds.push(requester.id, target.id);

    await db.insert(orgMemberships).values([
      { userId: requester.id, orgId, role: "administrator", status: "active" },
      { userId: target.id, orgId, role: "member", status: "active" },
    ]);

    const doc = await createDocDraft(memexId, "Replay Doc", "purpose");
    const shareToken = await createShareToken(memexId, doc.id, target.id);

    await disableMembership(target.id, orgId, requester.id);

    const err = await getSharedDocumentByToken(shareToken.token).catch((e) => e);
    expect(err).toBeInstanceOf(ShareTokenError);
    expect((err as ShareTokenError).reason).toBe("revoked");
  });

  it("tokens from other orgs are NOT revoked when a member is removed (ac-10)", async () => {
    tagAc(AC_199(10));
    const { orgId: orgA } = await makeOrgWithMemex();
    const { memexId: memexB } = await makeOrgWithMemex();

    const requester = await upsertUserByEmail(`req3-${Date.now()}@revoke.test`);
    const target = await upsertUserByEmail(`tgt3-${Date.now()}@revoke.test`);
    createdUserIds.push(requester.id, target.id);

    await db.insert(orgMemberships).values([
      { userId: requester.id, orgId: orgA, role: "administrator", status: "active" },
      { userId: target.id, orgId: orgA, role: "member", status: "active" },
    ]);

    const docB = await createDocDraft(memexB, "Other Org Doc", "purpose");
    const tokenB = await createShareToken(memexB, docB.id, target.id);

    await disableMembership(target.id, orgA, requester.id);

    const row = await db.query.shareTokens.findFirst({ where: eq(shareTokens.id, tokenB.id) });
    expect(row?.revoked, "token in a different org must not be revoked").toBe(false);
  });
});
