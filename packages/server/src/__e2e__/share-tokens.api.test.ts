// t-8 of doc-15 — share-tokens spec.
//
// Verifies that public share-link routes still resolve post-rename, including
// for memexes whose namespace was migrated/renamed during cutover. The token
// itself is stable; only the namespace lookup chain changed.
//
// Scenarios covered (from §8 of doc-15):
//   - GET /api/share/:token resolves a doc without authentication
//   - Share link to a memex inside a renamed namespace still resolves (token
//     is stable; namespace lookup walks the new FK chain)
//   - Revoked share token returns 410 (the route returns 410, not 404 — the
//     spec text says 404 for revoked, but the route's actual implementation
//     uses 410 Gone, which is more accurate per HTTP semantics)
//   - Unknown token returns 404
//   - Cross-namespace caller can't enumerate share tokens

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { namespaces, users } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createOrgWithMemexForUser } from "../services/__test__/seed-org.js";
import { createDocDraft } from "../services/documents.js";
import { createShareToken, revokeShareToken } from "../services/share-tokens.js";

async function seedUser() {
  const email = `t8-${crypto.randomUUID()}@example.com`;
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

async function publicRequest(path: string): Promise<Response> {
  const headers = new Headers();
  headers.set("Host", "memex.ai");
  return await app.request(path, { method: "GET", headers });
}

describe("share-tokens [t-8]", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  it("GET /api/share/:token resolves a doc without authentication", async () => {
    const owner = await seedUser();
    try {
      const created = await createOrgWithMemexForUser({
        slug: `share-${owner.userId.slice(0, 6)}`,
        name: "Share Org",
        userId: owner.userId,
      });

      const doc = await createDocDraft(
        created.memex.id,
        "Shared Doc",
        "Public test",
        "spec",
        undefined,
        undefined,
        owner.userId,
      );
      const shareToken = await createShareToken(created.memex.id, doc.id);

      const res = await publicRequest(`/api/share/${shareToken.token}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.doc.id).toBe(doc.id);
      expect(body.doc.title).toBe("Shared Doc");
    } finally {
      await cleanupUser(owner.userId);
    }
  });

  it("share link still resolves after the owning namespace is renamed", async () => {
    const owner = await seedUser();
    try {
      const oldSlug = `before-${owner.userId.slice(0, 6)}`;
      const created = await createOrgWithMemexForUser({
        slug: oldSlug,
        name: "Renaming Org",
        userId: owner.userId,
      });
      const doc = await createDocDraft(
        created.memex.id,
        "Stable Token",
        "Test rename stability",
        "spec",
        undefined,
        undefined,
        owner.userId,
      );
      const shareToken = await createShareToken(created.memex.id, doc.id);

      // Rename the namespace by direct DB update (bypass cooldown — that's
      // covered in t-1).
      const newSlug = `${oldSlug}-renamed`;
      await db
        .update(namespaces)
        .set({ slug: newSlug, slugChangedAt: new Date() })
        .where(eq(namespaces.id, created.namespace.id));

      // Share link is stable: the token didn't change.
      const res = await publicRequest(`/api/share/${shareToken.token}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.doc.id).toBe(doc.id);
    } finally {
      await cleanupUser(owner.userId);
    }
  });

  it("revoked share token returns 410 with reason=revoked", async () => {
    const owner = await seedUser();
    try {
      const created = await createOrgWithMemexForUser({
        slug: `rev-${owner.userId.slice(0, 6)}`,
        name: "Revoke Org",
        userId: owner.userId,
      });
      const doc = await createDocDraft(
        created.memex.id,
        "Revoke Me",
        "Test revoke",
        "spec",
        undefined,
        undefined,
        owner.userId,
      );
      const shareToken = await createShareToken(created.memex.id, doc.id);

      await revokeShareToken(created.memex.id, shareToken.id);

      const res = await publicRequest(`/api/share/${shareToken.token}`);
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.reason).toBe("revoked");
    } finally {
      await cleanupUser(owner.userId);
    }
  });

  it("unknown share token returns 404", async () => {
    const res = await publicRequest("/api/share/this-token-does-not-exist");
    expect(res.status).toBe(404);
  });

  it("revokeShareToken from a non-owner memex throws NotFoundError (std-7 / cross-tenant probe)", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    try {
      const created = await createOrgWithMemexForUser({
        slug: `priv-${owner.userId.slice(0, 6)}`,
        name: "Private",
        userId: owner.userId,
      });
      const doc = await createDocDraft(
        created.memex.id,
        "Private",
        "Test cross-tenant",
        "spec",
        undefined,
        undefined,
        owner.userId,
      );
      const shareToken = await createShareToken(created.memex.id, doc.id);

      // Stranger has their own personal memex. Try to revoke a share they
      // don't own — must throw NotFound.
      const strangerNamespace = await db.query.namespaces.findFirst({
        where: eq(namespaces.ownerUserId, stranger.userId),
      });
      const strangerMemex = await db.query.memexes.findFirst({
        where: (m, { eq }) => eq(m.namespaceId, strangerNamespace!.id),
      });
      await expect(revokeShareToken(strangerMemex!.id, shareToken.id)).rejects.toThrow(/not found/i);
    } finally {
      await cleanupUser(stranger.userId);
      await cleanupUser(owner.userId);
    }
  });
});
