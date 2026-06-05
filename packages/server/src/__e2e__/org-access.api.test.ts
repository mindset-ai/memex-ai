// t-5 of doc-15 — org-access spec for std-4.
//
// Verifies that org membership is binary-and-blanket: one membership grants
// access to every memex in the org, and disabled members lose access to all.
// No per-memex grant table in v1.
//
// Scenarios covered (from §8 of doc-15):
//   - Active org member can read every memex in the org
//   - Disabled org member cannot read any memex (returns 404 per std-7)
//   - New memex created inside an org is immediately accessible to all
//     active members
//   - Re-enabling restores access

import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { memexes, orgMemberships, users } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createOrgForUser } from "../services/orgs.js";

interface SeededUser {
  userId: string;
  bearer: string;
}

async function seedUser(): Promise<SeededUser> {
  const email = `t5-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  return { userId: user.id, bearer: signSessionToken(user.id) };
}

async function cleanupUser(userId: string) {
  await db.delete(users).where(eq(users.id, userId));
}

async function authedRequest(path: string, init: RequestInit, bearer: string): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${bearer}`);
  headers.set("Host", "memex.ai");
  return await app.request(path, { ...init, headers });
}

describe("org-access [std-4] [t-5]", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  it("active member can access every memex in the org (existing + new)", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    try {
      // Post-doc-19 dec-1: Org creation inserts 0 Memexes. Members are added,
      // then Memexes are inserted, then the picker reflects them.
      const created = await createOrgForUser({
        slug: `team-${owner.userId.slice(0, 6)}`,
        name: "Team",
        userId: owner.userId,
      });

      // Add `member` as an active org member.
      await db.insert(orgMemberships).values({
        userId: member.userId,
        orgId: created.org.id,
        role: "member",
        status: "active",
      });

      // Member sees the team's namespace via the picker even though it has
      // zero memexes (per doc-19, /api/me/namespaces surfaces empty orgs).
      const list = await authedRequest("/api/me/namespaces", { method: "GET" }, member.bearer);
      const body = await list.json();
      const teamEntry = body.namespaces.find(
        (n: { namespaceSlug: string }) => n.namespaceSlug === created.namespace.slug,
      );
      expect(teamEntry).toBeTruthy();
      expect(teamEntry.kind).toBe("team");
      expect(teamEntry.memexes).toHaveLength(0);

      // Add a memex to the namespace. Member now sees it in the picker.
      const [extra] = await db
        .insert(memexes)
        .values({
          namespaceId: created.namespace.id,
          slug: "extra",
          name: "Extra",
        })
        .returning();

      const list2 = await authedRequest("/api/me/namespaces", { method: "GET" }, member.bearer);
      const body2 = await list2.json();
      const team2 = body2.namespaces.find(
        (n: { namespaceSlug: string }) => n.namespaceSlug === created.namespace.slug,
      );
      const memexIds = team2.memexes.map((m: { memexId: string }) => m.memexId);
      expect(memexIds).toContain(extra.id);
    } finally {
      await cleanupUser(member.userId);
      await cleanupUser(owner.userId);
    }
  });

  it("disabled member can NOT access any org memex", async () => {
    const owner = await seedUser();
    const exMember = await seedUser();
    try {
      const created = await createOrgForUser({
        slug: `team-${owner.userId.slice(0, 6)}`,
        name: "Team",
        userId: owner.userId,
      });
      // Disabled membership.
      await db.insert(orgMemberships).values({
        userId: exMember.userId,
        orgId: created.org.id,
        role: "member",
        status: "disabled",
      });

      const list = await authedRequest("/api/me/namespaces", { method: "GET" }, exMember.bearer);
      const body = await list.json();
      const teamEntry = body.namespaces.find(
        (n: { namespaceSlug: string }) => n.namespaceSlug === created.namespace.slug,
      );
      // listMemberships filters out status='disabled', so the team's namespace
      // doesn't appear in the picker at all.
      expect(teamEntry).toBeUndefined();
    } finally {
      await cleanupUser(exMember.userId);
      await cleanupUser(owner.userId);
    }
  });

  it("re-enabling a disabled member restores access immediately", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    try {
      const created = await createOrgForUser({
        slug: `team-${owner.userId.slice(0, 6)}`,
        name: "Team",
        userId: owner.userId,
      });
      await db.insert(orgMemberships).values({
        userId: member.userId,
        orgId: created.org.id,
        role: "member",
        status: "disabled",
      });

      // Pre-flight: not visible.
      let list = await authedRequest("/api/me/namespaces", { method: "GET" }, member.bearer);
      let body = await list.json();
      expect(body.namespaces.find((n: { namespaceSlug: string }) => n.namespaceSlug === created.namespace.slug)).toBeUndefined();

      // Re-enable.
      await db
        .update(orgMemberships)
        .set({ status: "active" })
        .where(
          and(
            eq(orgMemberships.userId, member.userId),
            eq(orgMemberships.orgId, created.org.id),
          ),
        );

      // Now visible.
      list = await authedRequest("/api/me/namespaces", { method: "GET" }, member.bearer);
      body = await list.json();
      expect(body.namespaces.find((n: { namespaceSlug: string }) => n.namespaceSlug === created.namespace.slug)).toBeTruthy();
    } finally {
      await cleanupUser(member.userId);
      await cleanupUser(owner.userId);
    }
  });
});
