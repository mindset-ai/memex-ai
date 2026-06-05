// t-4 of doc-15 — domain-consent spec for std-6.
//
// Verifies the explicit-consent rule for domain-based auto-join. SSO callbacks
// no longer insert org_memberships unilaterally; the user opts in via the
// consent prompt at /api/consent.
//
// Scenarios covered (from §8 of doc-15):
//   - New user with claimed-domain email → /api/consent/pending lists the org
//   - Accept → org_memberships row inserted with role=member, status=active
//   - Decline → no row, sticky (no re-prompt)
//   - Skip + re-call → still no prompt for same (user, org)
//   - Disabled member → surfaces in `disabled` list, NOT `pending`. No mutations.
//   - Newly-verified domain → matching existing user sees prompt next call

import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import {
  orgConsentResponses,
  orgMemberships,
  orgs,
  users,
  verifiedDomains,
} from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createOrgForUser } from "../services/orgs.js";

interface SeededUser {
  userId: string;
  bearer: string;
  email: string;
}

async function seedUser(emailDomain: string = "example.com"): Promise<SeededUser> {
  const email = `t4-${crypto.randomUUID()}@${emailDomain}`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  const bearer = signSessionToken(user.id);
  return { userId: user.id, bearer, email };
}

async function cleanupUser(userId: string) {
  await db.delete(users).where(eq(users.id, userId));
}

async function authedRequest(path: string, init: RequestInit, bearer: string): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${bearer}`);
  headers.set("Host", "memex.ai");
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return await app.request(path, { ...init, headers });
}

// Sets up an org owned by `ownerUserId` with auto-grouping enabled and a
// verified email domain. Returns the org id.
async function seedOrgWithVerifiedDomain(opts: {
  ownerUserId: string;
  ownerBearer: string;
  slug: string;
  domain: string;
}): Promise<string> {
  const created = await createOrgForUser({
    slug: opts.slug,
    name: opts.slug.toUpperCase(),
    userId: opts.ownerUserId,
  });
  // Enable auto-grouping + claim the domain.
  await db.update(orgs).set({ autoGroupingEnabled: true }).where(eq(orgs.id, created.org.id));
  await db.insert(verifiedDomains).values({
    domain: opts.domain.toLowerCase(),
    orgId: created.org.id,
    verificationMethod: "sso",
  });
  return created.org.id;
}

describe("domain-consent [std-6] [t-4]", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  it("new user with matching domain sees the org in /api/consent/pending", async () => {
    const owner = await seedUser("example.com");
    const ORG_DOMAIN = `acme-${owner.userId.slice(0, 6)}.test`;
    const orgId = await seedOrgWithVerifiedDomain({
      ownerUserId: owner.userId,
      ownerBearer: owner.bearer,
      slug: `acme-${owner.userId.slice(0, 6)}`,
      domain: ORG_DOMAIN,
    });

    const newcomer = await seedUser(ORG_DOMAIN);
    try {
      const res = await authedRequest("/api/consent/pending", { method: "GET" }, newcomer.bearer);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pending).toHaveLength(1);
      expect(body.pending[0].orgId).toBe(orgId);
      expect(body.pending[0].domain).toBe(ORG_DOMAIN);
      expect(body.disabled).toHaveLength(0);
    } finally {
      await cleanupUser(newcomer.userId);
      await cleanupUser(owner.userId);
    }
  });

  it("accept consent inserts an active org_memberships row", async () => {
    const owner = await seedUser("example.com");
    const ORG_DOMAIN = `acme-${owner.userId.slice(0, 6)}.test`;
    const orgId = await seedOrgWithVerifiedDomain({
      ownerUserId: owner.userId,
      ownerBearer: owner.bearer,
      slug: `acme-${owner.userId.slice(0, 6)}`,
      domain: ORG_DOMAIN,
    });
    const newcomer = await seedUser(ORG_DOMAIN);
    try {
      const res = await authedRequest(
        "/api/consent/decisions",
        {
          method: "POST",
          body: JSON.stringify({ decisions: [{ orgId, response: "accepted" }] }),
        },
        newcomer.bearer,
      );
      expect(res.status).toBe(200);

      const memberships = await db
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.userId, newcomer.userId), eq(orgMemberships.orgId, orgId)));
      expect(memberships).toHaveLength(1);
      expect(memberships[0].role).toBe("member");
      expect(memberships[0].status).toBe("active");

      // Re-fetching pending: should be empty (already a member).
      const after = await authedRequest("/api/consent/pending", { method: "GET" }, newcomer.bearer);
      const afterBody = await after.json();
      expect(afterBody.pending).toHaveLength(0);
    } finally {
      await cleanupUser(newcomer.userId);
      await cleanupUser(owner.userId);
    }
  });

  it("decline records the response and never re-prompts (sticky per std-6)", async () => {
    const owner = await seedUser("example.com");
    const ORG_DOMAIN = `acme-${owner.userId.slice(0, 6)}.test`;
    const orgId = await seedOrgWithVerifiedDomain({
      ownerUserId: owner.userId,
      ownerBearer: owner.bearer,
      slug: `acme-${owner.userId.slice(0, 6)}`,
      domain: ORG_DOMAIN,
    });
    const newcomer = await seedUser(ORG_DOMAIN);
    try {
      await authedRequest(
        "/api/consent/decisions",
        {
          method: "POST",
          body: JSON.stringify({ decisions: [{ orgId, response: "declined" }] }),
        },
        newcomer.bearer,
      );

      // No org_memberships row.
      const memberships = await db
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.userId, newcomer.userId), eq(orgMemberships.orgId, orgId)));
      expect(memberships).toHaveLength(0);

      // Sticky — pending list should be empty on re-call.
      const re = await authedRequest("/api/consent/pending", { method: "GET" }, newcomer.bearer);
      const body = await re.json();
      expect(body.pending).toHaveLength(0);

      // Response row exists.
      const responses = await db
        .select()
        .from(orgConsentResponses)
        .where(
          and(
            eq(orgConsentResponses.userId, newcomer.userId),
            eq(orgConsentResponses.orgId, orgId),
          ),
        );
      expect(responses).toHaveLength(1);
      expect(responses[0].response).toBe("declined");
    } finally {
      await cleanupUser(newcomer.userId);
      await cleanupUser(owner.userId);
    }
  });

  it("skip is sticky — subsequent /api/consent/pending calls don't re-show", async () => {
    const owner = await seedUser("example.com");
    const ORG_DOMAIN = `acme-${owner.userId.slice(0, 6)}.test`;
    const orgId = await seedOrgWithVerifiedDomain({
      ownerUserId: owner.userId,
      ownerBearer: owner.bearer,
      slug: `acme-${owner.userId.slice(0, 6)}`,
      domain: ORG_DOMAIN,
    });
    const newcomer = await seedUser(ORG_DOMAIN);
    try {
      // First call shows the prompt.
      const first = await authedRequest("/api/consent/pending", { method: "GET" }, newcomer.bearer);
      const firstBody = await first.json();
      expect(firstBody.pending).toHaveLength(1);

      // Skip.
      await authedRequest(
        "/api/consent/decisions",
        {
          method: "POST",
          body: JSON.stringify({ decisions: [{ orgId, response: "skipped" }] }),
        },
        newcomer.bearer,
      );

      // Re-call — must not re-prompt.
      const second = await authedRequest("/api/consent/pending", { method: "GET" }, newcomer.bearer);
      const secondBody = await second.json();
      expect(secondBody.pending).toHaveLength(0);
    } finally {
      await cleanupUser(newcomer.userId);
      await cleanupUser(owner.userId);
    }
  });

  it("disabled member surfaces in `disabled` list, NOT `pending`; no row mutations", async () => {
    const owner = await seedUser("example.com");
    const ORG_DOMAIN = `acme-${owner.userId.slice(0, 6)}.test`;
    const orgId = await seedOrgWithVerifiedDomain({
      ownerUserId: owner.userId,
      ownerBearer: owner.bearer,
      slug: `acme-${owner.userId.slice(0, 6)}`,
      domain: ORG_DOMAIN,
    });
    const ex = await seedUser(ORG_DOMAIN);
    try {
      // Pre-seed a disabled membership for the user.
      await db.insert(orgMemberships).values({
        userId: ex.userId,
        orgId,
        role: "member",
        status: "disabled",
      });

      const res = await authedRequest("/api/consent/pending", { method: "GET" }, ex.bearer);
      const body = await res.json();
      expect(body.pending).toHaveLength(0);
      expect(body.disabled).toHaveLength(1);
      expect(body.disabled[0].orgId).toBe(orgId);

      // No reactivation possible via the consent path: even if the user (somehow)
      // POSTs accept for that org, the service short-circuits because the org
      // isn't in the pending list.
      await authedRequest(
        "/api/consent/decisions",
        {
          method: "POST",
          body: JSON.stringify({ decisions: [{ orgId, response: "accepted" }] }),
        },
        ex.bearer,
      );
      const memberships = await db
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.userId, ex.userId), eq(orgMemberships.orgId, orgId)));
      expect(memberships[0].status).toBe("disabled"); // unchanged
    } finally {
      await cleanupUser(ex.userId);
      await cleanupUser(owner.userId);
    }
  });

  it("newly-verified domain surfaces the prompt to existing matching users", async () => {
    const owner = await seedUser("example.com");
    const FUTURE_DOMAIN = `future-${owner.userId.slice(0, 6)}.test`;

    const newcomer = await seedUser(FUTURE_DOMAIN);
    try {
      // Owner creates an org BUT doesn't claim the domain yet. Newcomer should
      // see no pending prompts.
      const created = await createOrgForUser({
        slug: `future-${owner.userId.slice(0, 6)}`,
        name: "Future",
        userId: owner.userId,
      });
      await db.update(orgs).set({ autoGroupingEnabled: true }).where(eq(orgs.id, created.org.id));

      const before = await authedRequest("/api/consent/pending", { method: "GET" }, newcomer.bearer);
      const beforeBody = await before.json();
      expect(beforeBody.pending).toHaveLength(0);

      // Domain gets claimed AFTER newcomer signed up.
      await db.insert(verifiedDomains).values({
        domain: FUTURE_DOMAIN.toLowerCase(),
        orgId: created.org.id,
        verificationMethod: "sso",
      });

      const after = await authedRequest("/api/consent/pending", { method: "GET" }, newcomer.bearer);
      const afterBody = await after.json();
      expect(afterBody.pending).toHaveLength(1);
      expect(afterBody.pending[0].orgId).toBe(created.org.id);
    } finally {
      await cleanupUser(newcomer.userId);
      await cleanupUser(owner.userId);
    }
  });
});
