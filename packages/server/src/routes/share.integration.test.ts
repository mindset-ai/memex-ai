import { describe, it, expect, afterAll, vi } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgMemberships,
  shareTokens,
  docSections,
  docComments,
} from "../db/schema.js";

// share.ts captures `process.env.GOOGLE_CLIENT_ID` at module load to decide whether the
// Bearer verify path is active. Rather than race vitest hook ordering with env mutation,
// stub google-auth-library directly — any Bearer token passed in the test is "verified"
// against a fixed payload we control.
const MOCK_EXTERNAL_EMAIL = "external-commenter@test.example";
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    async verifyIdToken() {
      return {
        getPayload: () => ({
          email: MOCK_EXTERNAL_EMAIL,
          email_verified: true,
          name: "External Commenter",
        }),
      };
    }
  },
}));

import { Hono } from "hono";
import { shareRouter } from "./share.js";
import { errorHandler } from "../middleware/error-handler.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { createShareToken } from "../services/share-tokens.js";
import { upsertUserByEmail } from "../services/users.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";

const createdAccountIds: string[] = [];

afterAll(async () => {
  if (createdAccountIds.length) {
    await db
      .delete(memexes)
      .where(inArray(memexes.id, createdAccountIds))
      .catch(() => {});
  }
});

const app = new Hono();
app.onError(errorHandler);
app.route("/api/share", shareRouter);

async function seedCommenter(memexId: string): Promise<string> {
  // The mocked verifyIdToken returns MOCK_EXTERNAL_EMAIL; upsert that user, ensure their
  // personal namespace is provisioned (the route's resolveAuthorizedCommenter requires
  // user.namespaceId — same gate every real sign-in path goes through via
  // ensureUserNamespace), and give them a membership on the org owning this memex's
  // namespace.
  const user = await upsertUserByEmail(MOCK_EXTERNAL_EMAIL);
  await ensureUserNamespace(user.id);
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) return user.id;
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, memex.namespaceId) });
  if (!ns?.ownerOrgId) return user.id;
  await db
    .insert(orgMemberships)
    .values({ userId: user.id, orgId: ns.ownerOrgId, role: "member" })
    .onConflictDoNothing();
  return user.id;
}

describe("GET /api/share/:token", () => {
  it("returns the doc payload for a valid token", async () => {
    const memexId = await makeTestMemex("share-get");
    createdAccountIds.push(memexId);
    const doc = await createDocDraft(memexId, "Shared Doc", "Purpose");
    const share = await createShareToken(memexId, doc.id);

    const res = await app.request(`/api/share/${share.token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Accept either `document` or `doc` in the payload — the exact key has evolved. Assert
    // against whichever is present; the important invariant is that the fetched doc's id
    // matches what we seeded.
    const docPayload = (body.document ?? body.doc) as
      | { id: string; title: string }
      | undefined;
    expect(docPayload).toBeDefined();
    expect(docPayload!.id).toBe(doc.id);
    expect(docPayload!.title).toBe("Shared Doc");
  });

  it("returns 404 with reason=unknown for an unknown token", async () => {
    const res = await app.request(
      "/api/share/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe("unknown");
  });

  it("returns 410 with reason=revoked for a revoked token", async () => {
    const memexId = await makeTestMemex("share-revoked");
    createdAccountIds.push(memexId);
    const doc = await createDocDraft(memexId, "Rev Doc", "Purpose");
    const share = await createShareToken(memexId, doc.id);

    await db
      .update(shareTokens)
      .set({ revoked: true })
      .where(eq(shareTokens.id, share.id));

    const res = await app.request(`/api/share/${share.token}`);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.reason).toBe("revoked");
  });
});

describe("POST /api/share/:token/comments", () => {
  it("creates a comment on a shared section when a Bearer token verifies", async () => {
    const memexId = await makeTestMemex("share-comment");
    createdAccountIds.push(memexId);
    const doc = await createDocDraft(memexId, "Commentable", "Purpose");
    const share = await createShareToken(memexId, doc.id);
    await seedCommenter(memexId);

    const [section] = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, doc.id));
    expect(section).toBeDefined();

    const res = await app.request(`/api/share/${share.token}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock-id-token",
      },
      body: JSON.stringify({
        target: { kind: "section", id: section.id },
        content: "External comment from outside",
      }),
    });

    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.content).toBe("External comment from outside");

    const [row] = await db
      .select()
      .from(docComments)
      .where(eq(docComments.id, created.id));
    expect(row).toBeDefined();
    expect(row.sectionId).toBe(section.id);
  });

  it("rejects a missing or malformed target with 400", async () => {
    const memexId = await makeTestMemex("share-bad-target");
    createdAccountIds.push(memexId);
    const doc = await createDocDraft(memexId, "Bad", "Purpose");
    const share = await createShareToken(memexId, doc.id);

    const res = await app.request(`/api/share/${share.token}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock-id-token",
      },
      body: JSON.stringify({ content: "missing target" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 410 when the share token is revoked", async () => {
    const memexId = await makeTestMemex("share-comment-revoked");
    createdAccountIds.push(memexId);
    const doc = await createDocDraft(memexId, "RevComment", "Purpose");
    const share = await createShareToken(memexId, doc.id);
    await seedCommenter(memexId);
    await db
      .update(shareTokens)
      .set({ revoked: true })
      .where(eq(shareTokens.id, share.id));

    const [section] = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, doc.id));

    const res = await app.request(`/api/share/${share.token}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock-id-token",
      },
      body: JSON.stringify({
        target: { kind: "section", id: section.id },
        content: "should not land",
      }),
    });
    expect(res.status).toBe(410);
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const memexId = await makeTestMemex("share-no-auth");
    createdAccountIds.push(memexId);
    const doc = await createDocDraft(memexId, "NoAuth", "Purpose");
    const share = await createShareToken(memexId, doc.id);

    const [section] = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, doc.id));

    const res = await app.request(`/api/share/${share.token}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { kind: "section", id: section.id },
        content: "anon",
      }),
    });
    expect(res.status).toBe(401);
  });
});
