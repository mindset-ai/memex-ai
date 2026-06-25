// spec-199 t-6 — anonymous-path column projection for GET /activity.
//
// This file deliberately does NOT set GOOGLE_CLIENT_ID="". A non-empty
// stub value means isDevMode() returns false so requests without an
// Authorization header are truly anonymous (currentUserId null,
// currentAccessLevel null) rather than auto-logged in as dev@memex.ai.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "stub-non-empty-for-t6-anon-test";
  return undefined;
});

import { db } from "../db/connection.js";
import {
  activityLog,
  memexes,
  namespaces,
  orgs,
  orgMemberships,
} from "../db/schema.js";
import type { ActivityLogInsert } from "../db/schema.js";
import { app } from "../app.js";
import { upsertUserByEmail } from "../services/users.js";

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
}

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

const insertedActivityIds: string[] = [];
const createdMemexIds: string[] = [];
const createdNamespaceIds: string[] = [];

let publicMemexId: string;
let publicPath: string;

async function seedActivity(over: Partial<ActivityLogInsert> = {}): Promise<Record<string, unknown>> {
  const [row] = await db
    .insert(activityLog)
    .values({
      memexId: publicMemexId,
      actorKind: over.actorKind ?? "human",
      channel: over.channel ?? "rest_ui",
      entity: over.entity ?? "document",
      action: over.action ?? "updated",
      narrative: over.narrative ?? "seeded",
      actorUserId: over.actorUserId ?? null,
      clientId: over.clientId ?? null,
      payload: over.payload ?? null,
    })
    .returning();
  insertedActivityIds.push(row.id);
  return row as unknown as Record<string, unknown>;
}

beforeAll(async () => {
  const dev = await upsertUserByEmail("dev@memex.ai");

  const [ns] = await db
    .insert(namespaces)
    .values({ slug: uniqueSlug("anon-act"), kind: "org" })
    .returning();
  createdNamespaceIds.push(ns.id);

  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: "Anon Activity Test", emailDomains: [] })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));

  const [memex] = await db
    .insert(memexes)
    .values({
      namespaceId: ns.id,
      slug: "main",
      name: "Anon Activity Memex",
      visibility: "public",
    })
    .returning();
  createdMemexIds.push(memex.id);

  publicMemexId = memex.id;
  publicPath = `/api/${ns.slug}/main`;

  await db
    .insert(orgMemberships)
    .values({ userId: dev.id, orgId: org.id, role: "administrator" })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (insertedActivityIds.length) {
    await db
      .delete(activityLog)
      .where(inArray(activityLog.id, insertedActivityIds))
      .catch(() => {});
  }
  if (createdMemexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
});

const AC_6 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-6";

// spec-199 t-6: anonymous caller on a public memex receives only the
// whitelisted columns — payload, actorUserId, and clientId are stripped.
describe("spec-199 t-6 — GET /activity anonymous column projection (ac-6)", () => {
  it("anonymous caller receives no payload, actorUserId, or clientId on a public memex", async () => {
    tagAc(AC_6);

    // actorUserId is a nullable UUID FK — keep it null to avoid the FK constraint.
    // clientId and payload are the load-bearing sensitive fields we're guarding.
    await seedActivity({
      clientId: "anon-test-client-id",
      payload: { query: "sensitive search text" },
      narrative: "searched something sensitive",
    });

    // No Authorization header + GOOGLE_CLIENT_ID non-empty → truly anonymous.
    const res = await app.request(`${publicPath}/activity`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.length).toBeGreaterThan(0);

    for (const row of body) {
      expect(row, "payload must be absent from anonymous response").not.toHaveProperty("payload");
      expect(row, "actorUserId must be absent from anonymous response").not.toHaveProperty("actorUserId");
      expect(row, "clientId must be absent from anonymous response").not.toHaveProperty("clientId");
      // Whitelisted columns must still be present.
      expect(row).toHaveProperty("id");
      expect(row).toHaveProperty("narrative");
      expect(row).toHaveProperty("createdAt");
    }
  });
});
