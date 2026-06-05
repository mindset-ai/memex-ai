// HTTP route tests for the AC tab endpoints.
//
// Service-level derivation is covered separately in
// services/acs-verification.integration.test.ts. This suite exercises the
// HTTP layer: tenant scoping, auth gate, payload shape, days-param clamp,
// 404 on cross-tenant access.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users, documents, acs, testEvents, testEventLatest } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";
import { createDocDraft } from "../services/documents.js";
import { createAc } from "../services/acs.js";
import { seedTestEvent } from "../services/test-helpers.js";

const createdUserIds: string[] = [];
const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

afterAll(async () => {
  if (createdAcUids.length) {
    await db
      .delete(testEvents)
      .where(inArray(testEvents.acUid, createdAcUids))
      .catch(() => {});
    await db
      .delete(testEventLatest)
      .where(inArray(testEventLatest.acUid, createdAcUids))
      .catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `acs-routes-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);
  return u.id;
}

async function authedRequest(
  path: string,
  bearer: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${bearer}`);
  headers.set("Host", "memex.ai");
  return app.request(path, { ...init, headers });
}

describe("GET /api/:namespace/:memex/acs/doc/:docId [acs route]", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  let userId: string;
  let bearer: string;
  let namespace: string;
  let memex: string;
  let memexId: string;
  let briefId: string;
  let briefHandle: string;

  beforeAll(async () => {
    userId = await seedUser();
    bearer = signSessionToken(userId);
    const seeded = await createOrgWithMemexAndOwner({
      slug: `acs-r-${Date.now().toString(36)}`,
      ownerUserId: userId,
    });
    namespace = seeded.namespace.slug;
    memex = seeded.memex.slug;
    memexId = seeded.memex.id;
    const doc = await createDocDraft(
      memexId,
      "AC route test spec",
      "purpose",
      "spec",
    );
    createdDocIds.push(doc.id);
    briefId = doc.id;
    briefHandle = doc.handle!;

    // Two ACs: one untested, one with a pass event.
    const scopeAc = await createAc({
      memexId,
      briefId,
      kind: "scope",
      statement: "scope claim",
    });
    await createAc({
      memexId,
      briefId,
      kind: "implementation",
      statement: "impl claim untested",
    });
    const scopeRef = `${namespace}/${memex}/specs/${briefHandle}/acs/ac-${scopeAc.seq}`;
    createdAcUids.push(scopeRef);
    // spec-162: seed via the insert+summary-upsert path so the verification GET
    // (now backed by test_event_latest) reports this AC as verified.
    await seedTestEvent({
      acUid: scopeRef,
      status: "pass",
      testIdentifier: "smoke/test.ts::it works",
    });
  });

  // spec-111 t-10: the AC GET routes now sit behind the permissive public-read
  // session. The seeded memex is PRIVATE (default visibility), so an anonymous
  // caller must get a std-7 404 — indistinguishable from a non-existent memex —
  // NOT the old 401. (A 401 would leak that the memex exists but is gated.)
  it("returns 404 (std-7) without an Authorization header on a private memex", async () => {
    const res = await app.request(`/api/${namespace}/${memex}/acs/doc/${briefId}`, {
      headers: { Host: "memex.ai" },
    });
    expect(res.status).toBe(404);
  });

  it("returns the denormalised snapshot with verification state per AC", async () => {
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/doc/${briefId}`,
      bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      ac: { kind: string; seq: number; statement: string };
      canonicalRef: string;
      tests: unknown[];
      verificationState: string;
      parents: Array<{ kind: string; id: string }>;
    }>;
    expect(body.length).toBe(2);
    const scopeRow = body.find((r) => r.ac.kind === "scope")!;
    const implRow = body.find((r) => r.ac.kind === "implementation")!;
    expect(scopeRow.verificationState).toBe("verified");
    expect(scopeRow.tests.length).toBe(1);
    expect(scopeRow.canonicalRef).toMatch(
      new RegExp(`^${namespace}/${memex}/specs/${briefHandle}/acs/ac-\\d+$`),
    );
    expect(implRow.verificationState).toBe("untested");
    expect(implRow.tests).toEqual([]);
    // parents[] is always present on the response — empty array when no
    // parent links recorded (which is the case for these seeded ACs).
    expect(Array.isArray(scopeRow.parents)).toBe(true);
    expect(Array.isArray(implRow.parents)).toBe(true);
  });

  it("returns 404 when a different user tries to fetch a spec they don't own", async () => {
    // Seed a SECOND user and try to read the first user's spec through
    // their own tenant prefix. The cross-tenant case (correct prefix, wrong
    // user) is what we're checking — the path resolves but membership fails.
    const otherUserId = await seedUser();
    const otherBearer = signSessionToken(otherUserId);
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/doc/${briefId}`,
      otherBearer,
    );
    // Per std-7, non-members get 404 not 403 (can't distinguish "doesn't
    // exist" from "you can't see it"). The route resolves the namespace +
    // memex path but the membership check fails.
    expect([404, 401]).toContain(res.status);
  });
});

describe("GET /api/:namespace/:memex/acs/doc/:docId/alignment-history [days clamp]", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  let bearer: string;
  let namespace: string;
  let memex: string;
  let briefId: string;

  beforeAll(async () => {
    const userId = await seedUser();
    bearer = signSessionToken(userId);
    const seeded = await createOrgWithMemexAndOwner({
      slug: `acs-h-${Date.now().toString(36)}`,
      ownerUserId: userId,
    });
    namespace = seeded.namespace.slug;
    memex = seeded.memex.slug;
    const doc = await createDocDraft(
      seeded.memex.id,
      "AC history spec",
      "purpose",
      "spec",
    );
    createdDocIds.push(doc.id);
    briefId = doc.id;
    // Add one AC so the query has at least one to walk.
    await createAc({
      memexId: seeded.memex.id,
      briefId,
      kind: "implementation",
      statement: "anchor AC",
    });
  });

  it("clamps days < 7 up to 7", async () => {
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/doc/${briefId}/alignment-history?days=1`,
      bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ date: string; kind: string }>;
    const uniqueDates = new Set(body.map((d) => d.date));
    // 7 days × 1 kind ('implementation' — scope had zero ACs) = 7 buckets.
    expect(uniqueDates.size).toBe(7);
  });

  it("clamps days > 90 down to 90", async () => {
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/doc/${briefId}/alignment-history?days=10000`,
      bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ date: string }>;
    const uniqueDates = new Set(body.map((d) => d.date));
    expect(uniqueDates.size).toBe(90);
  });

  it("defaults to 30 days when ?days is absent", async () => {
    const res = await authedRequest(
      `/api/${namespace}/${memex}/acs/doc/${briefId}/alignment-history`,
      bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ date: string }>;
    const uniqueDates = new Set(body.map((d) => d.date));
    expect(uniqueDates.size).toBe(30);
  });
});
