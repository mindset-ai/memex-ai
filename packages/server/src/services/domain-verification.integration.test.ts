import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, domainVerificationTokens, verifiedDomains } from "../db/schema.js";
import {
  createDomainVerificationToken,
  consumeDomainVerificationToken,
  cleanupExpiredDomainVerificationTokens,
  DomainVerificationError,
} from "./domain-verification.js";
import { ConflictError, ValidationError } from "../types/errors.js";

const createdAccountIds: string[] = [];
const createdDomains: string[] = [];

afterAll(async () => {
  if (createdDomains.length) {
    await db.delete(verifiedDomains).where(inArray(verifiedDomains.domain, createdDomains)).catch(() => {});
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

// Returns the org.id (domain-verification keys on org_id post-doc-15).
async function makeAccount(emailDomains: string[] = []): Promise<string> {
  const sub = uniqueSubdomain("dv");
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "DV Test", emailDomains }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [acct] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "DV Test" }).returning();
  createdAccountIds.push(acct.id);
  return org.id;
}

describe("createDomainVerificationToken", () => {
  it("creates a token with 24h expiration", async () => {
    const domain = uniqueDomain("ok");
    createdDomains.push(domain);
    const memexId = await makeAccount([domain]);

    const before = Date.now();
    const tok = await createDomainVerificationToken(memexId, domain);

    expect(tok.orgId).toBe(memexId);
    expect(tok.domain).toBe(domain);
    expect(tok.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(tok.used).toBe(false);

    const ttlMs = tok.expiresAt.getTime() - before;
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(ttlMs).toBeGreaterThanOrEqual(oneDayMs - 5000);
    expect(ttlMs).toBeLessThanOrEqual(oneDayMs + 5000);
  });

  it("rejects domains not in the account's email_domains list", async () => {
    const memexId = await makeAccount([]);
    await expect(createDomainVerificationToken(memexId, "acme.com")).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("rejects free email domains (dec-7)", async () => {
    const memexId = await makeAccount(["gmail.com"]);
    await expect(createDomainVerificationToken(memexId, "gmail.com")).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("rejects domains already verified by another account (dec-16)", async () => {
    const domain = uniqueDomain("claimed");
    createdDomains.push(domain);
    const accountA = await makeAccount([domain]);
    const accountB = await makeAccount([domain]);

    // Pre-claim by A
    await db.insert(verifiedDomains).values({
      domain,
      orgId: accountA,
      verificationMethod: "sso",
    } as any);

    await expect(createDomainVerificationToken(accountB, domain)).rejects.toBeInstanceOf(
      ConflictError
    );
  });

  it("rejects malformed input", async () => {
    const memexId = await makeAccount(["acme.com"]);
    await expect(createDomainVerificationToken(memexId, "")).rejects.toBeInstanceOf(
      ValidationError
    );
    await expect(createDomainVerificationToken(memexId, "no-dot")).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});

describe("consumeDomainVerificationToken", () => {
  it("creates verified_domains row and marks token used", async () => {
    const domain = uniqueDomain("consume");
    createdDomains.push(domain);
    const memexId = await makeAccount([domain]);

    const tok = await createDomainVerificationToken(memexId, domain);
    const verified = await consumeDomainVerificationToken(tok.token);

    expect(verified.domain).toBe(domain);
    expect(verified.orgId).toBe(memexId);
    expect(verified.verificationMethod).toBe("email");

    const reloaded = await db.query.domainVerificationTokens.findFirst({
      where: eq(domainVerificationTokens.id, tok.id),
    });
    expect(reloaded?.used).toBe(true);
  });

  it("rejects unknown tokens", async () => {
    await expect(consumeDomainVerificationToken("does-not-exist"))
      .rejects.toMatchObject({ name: "DomainVerificationError", reason: "unknown" });
  });

  it("rejects expired tokens", async () => {
    const domain = uniqueDomain("exp");
    createdDomains.push(domain);
    const memexId = await makeAccount([domain]);

    const tok = await createDomainVerificationToken(memexId, domain);
    await db
      .update(domainVerificationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(domainVerificationTokens.id, tok.id));

    await expect(consumeDomainVerificationToken(tok.token))
      .rejects.toMatchObject({ name: "DomainVerificationError", reason: "expired" });
  });

  it("is idempotent for re-clicks (returns existing verification on used token)", async () => {
    const domain = uniqueDomain("idem");
    createdDomains.push(domain);
    const memexId = await makeAccount([domain]);

    const tok = await createDomainVerificationToken(memexId, domain);
    const first = await consumeDomainVerificationToken(tok.token);
    // Re-click after success: the conditional mark-used is skipped (row already used) and
    // upsertVerifiedDomain is idempotent — returns the existing verification row.
    const second = await consumeDomainVerificationToken(tok.token);
    expect(second.domain).toBe(first.domain);
    expect(second.orgId).toBe(first.orgId);
  });

  it("only one of two concurrent claims succeeds", async () => {
    const domain = uniqueDomain("race");
    createdDomains.push(domain);
    const memexId = await makeAccount([domain]);

    const tok = await createDomainVerificationToken(memexId, domain);

    const [a, b] = await Promise.allSettled([
      consumeDomainVerificationToken(tok.token),
      consumeDomainVerificationToken(tok.token),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DomainVerificationError);
  });
});

describe("cleanupExpiredDomainVerificationTokens", () => {
  it("deletes only expired rows", async () => {
    const domain = uniqueDomain("cln");
    createdDomains.push(domain);
    const memexId = await makeAccount([domain]);

    const active = await createDomainVerificationToken(memexId, domain);
    const expired = await createDomainVerificationToken(memexId, domain);
    await db
      .update(domainVerificationTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(domainVerificationTokens.id, expired.id));

    const deleted = await cleanupExpiredDomainVerificationTokens();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db.query.domainVerificationTokens.findMany({
      where: eq(domainVerificationTokens.orgId, memexId),
    });
    expect(remaining.map((r) => r.id)).toEqual([active.id]);
  });
});
