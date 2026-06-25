// spec-315 t-2 — the graduated Home surface API (integration), through the full Hono
// app + strict sessionMiddleware. Tagged ac-6 (aggregates across the user's memexes,
// each item labelled with its Memex and linking into that Memex's spec).
//
// Auth as a FRESH unique user so the user-level read only ever sees this test's
// seeded data (the service itself is exhaustively unit-tested in specs-in-flight).
import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { namespaces, orgs, memexes, orgMemberships, users } from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { createDocDraft } from "../services/documents.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC6 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-6";

const auth = (userId: string): Record<string, string> => ({
  Authorization: `Bearer ${signSessionToken(userId)}`,
});

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

async function newUser(): Promise<string> {
  const u = await upsertUserByEmail(`home-api-${randomUUID()}@example.com`);
  createdUserIds.push(u.id);
  return u.id;
}

async function makeMemex(adminUserId: string): Promise<{ memexId: string; slug: string }> {
  const slug = `home-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`.slice(0, 39);
  const { ns, org, memex } = await db.transaction(async (tx) => {
    const [ns] = await tx.insert(namespaces).values({ slug, kind: "org" }).returning();
    const [org] = await tx.insert(orgs).values({ namespaceId: ns.id, name: "Test home" }).returning();
    await tx.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    return { ns, org, memex };
  });
  createdNamespaceIds.push(ns.id);
  await db
    .insert(orgMemberships)
    .values({ userId: adminUserId, orgId: org.id, role: "administrator" })
    .onConflictDoNothing();
  return { memexId: memex.id, slug: ns.slug };
}

afterAll(async () => {
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds));
  }
  if (createdUserIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.ownerUserId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("GET /api/me/home (spec-315 t-2)", () => {
  it("returns specs-in-flight with memex provenance, and an (empty) where-you're-needed block (ac-6)", async () => {
    tagAc(AC6);
    const userId = await newUser();
    const mx = await makeMemex(userId);
    const spec = await createDocDraft(
      mx.memexId,
      "Home API Spec",
      "purpose",
      "spec",
      undefined,
      undefined,
      userId,
      { actorUserId: userId },
    );

    const res = await app.request("/api/me/home", { headers: auth(userId) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      whereYoureNeeded: unknown[];
      specs: Array<{
        docId: string;
        handle: string;
        title: string;
        phase: string;
        memexId: string;
        namespaceSlug: string;
        memexSlug: string;
        tier: string;
        path: string;
      }>;
    };

    // where-you're-needed is empty for a fresh user with no mentions/assignments.
    expect(body.whereYoureNeeded).toEqual([]);

    const card = body.specs.find((s) => s.docId === spec.id);
    expect(card).toBeDefined();
    expect(card!.title).toBe("Home API Spec");
    expect(card!.memexId).toBe(mx.memexId); // labelled with the owning Memex
    expect(card!.namespaceSlug).toBe(mx.slug);
    expect(card!.memexSlug).toBe("main");
    expect(card!.path).toBe(`/${mx.slug}/main/specs/${spec.handle}`); // links into that Memex's spec
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/api/me/home");
    expect(res.status).toBe(401);
  });
});
