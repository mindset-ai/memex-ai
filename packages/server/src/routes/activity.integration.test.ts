import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Force dev-mode auth so app.request() can hit session-gated routes without
// minting a JWT (same shape as aggregates.integration.test.ts).
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { db } from "../db/connection.js";
import { activityLog, documents, memexes } from "../db/schema.js";
import type { ActivityLogInsert } from "../db/schema.js";
import { app } from "../app.js";
import { createDocDraft } from "../services/documents.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";

// Path-based routing per std-2 / dec-3 of doc-15: memexResolver parses
// `/api/<ns-slug>/main/...` from the URL; Host is the apex `memex.ai`.
// makeTestMemexWithDevAdmin enrolls dev@memex.ai as administrator so the
// session middleware lets requests through.

type Row = {
  id: string;
  memexId: string;
  briefId: string | null;
  actorUserId: string | null;
  clientId: string | null;
  entity: string;
  action: string;
  narrative: string;
  payload: unknown;
  createdAt: string;
};

const insertedActivityIds: string[] = [];
const createdDocIds: string[] = [];
const memexIds: string[] = [];

let memexA: string;
let pathA: string;
let memexB: string;
let pathB: string;

// Two real users for the actorUserId filter (actor_user_id is a real FK).
let alice: string;
let bob: string;

// A real spec in memex A so briefId resolution (handle → id) has something to
// resolve to.
let briefAHandle: string;
let briefAId: string;

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

// Seed one activity_log row directly. We bypass the bus/sink entirely — this
// endpoint just reads `activity_log`, so writing rows straight to the table is
// the most direct, deterministic way to exercise the query surface.
async function seedActivity(over: Partial<ActivityLogInsert>): Promise<Row> {
  const [row] = await db
    .insert(activityLog)
    .values({
      memexId: over.memexId!,
      briefId: over.briefId ?? null,
      actorUserId: over.actorUserId ?? null,
      actorKind: over.actorKind ?? "human",
      channel: over.channel ?? "rest_ui",
      clientId: over.clientId ?? null,
      entity: over.entity ?? "document",
      action: over.action ?? "updated",
      narrative: over.narrative ?? "seeded",
      payload: over.payload ?? null,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    })
    .returning();
  insertedActivityIds.push(row.id);
  return row as unknown as Row;
}

beforeAll(async () => {
  const a = await makeTestMemexWithDevAdmin("pulse-a");
  memexA = a.memexId;
  pathA = `/api/${a.slug}/main`;
  memexIds.push(a.memexId);

  const b = await makeTestMemexWithDevAdmin("pulse-b");
  memexB = b.memexId;
  pathB = `/api/${b.slug}/main`;
  memexIds.push(b.memexId);

  alice = (await upsertUserByEmail("pulse-alice@example.com")).id;
  bob = (await upsertUserByEmail("pulse-bob@example.com")).id;

  const spec = await createDocDraft(memexA, "Pulse Spec", "Purpose", "spec");
  briefAId = spec.id;
  briefAHandle = spec.handle;
  createdDocIds.push(spec.id);
});

afterAll(async () => {
  if (insertedActivityIds.length) {
    await db
      .delete(activityLog)
      .where(inArray(activityLog.id, insertedActivityIds))
      .catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
  if (memexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
  }
});

describe("GET /api/<ns>/<mx>/activity (Pulse history — b-60 t-12)", () => {
  it("scopes to the requested Memex only — never another tenant's rows", async () => {
    const inA = await seedActivity({ memexId: memexA, narrative: "in A" });
    const inB = await seedActivity({ memexId: memexB, narrative: "in B" });

    const res = await app.request(`${pathA}/activity`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row[];

    const ids = body.map((r) => r.id);
    expect(ids).toContain(inA.id);
    expect(ids).not.toContain(inB.id);
    // Every returned row belongs to memex A.
    expect(body.every((r) => r.memexId === memexA)).toBe(true);
  });

  it("returns rows newest-first (created_at DESC, id DESC)", async () => {
    const localPath = `${pathA}/activity?limit=200`;
    const res = await app.request(localPath, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row[];
    for (let i = 1; i < body.length; i++) {
      expect(
        new Date(body[i - 1].createdAt).getTime() >=
          new Date(body[i].createdAt).getTime(),
      ).toBe(true);
    }
  });

  it("cross-tenant access returns 404, not 403 (std-7) for an unknown namespace", async () => {
    // A namespace slug that doesn't exist → memexResolver 404s before any
    // handler runs. std-7: unauthorized/cross-tenant access is indistinguishable
    // from a missing resource.
    const res = await app.request(
      "/api/this-namespace-does-not-exist-xyz/main/activity",
      withApexHost(),
    );
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("filters by briefId — accepts a `b-N` handle and resolves it to the id", async () => {
    const onBrief = await seedActivity({
      memexId: memexA,
      briefId: briefAId,
      narrative: "touched the spec",
    });
    const offBrief = await seedActivity({
      memexId: memexA,
      briefId: null,
      narrative: "no spec",
    });

    // Pass the human-facing `b-N` handle — the route resolves handle → id.
    const res = await app.request(
      `${pathA}/activity?briefId=${encodeURIComponent(briefAHandle)}`,
      withApexHost(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row[];
    const ids = body.map((r) => r.id);
    expect(ids).toContain(onBrief.id);
    expect(ids).not.toContain(offBrief.id);
    expect(body.every((r) => r.briefId === briefAId)).toBe(true);
  });

  it("filters by briefId — also accepts the canonical UUID", async () => {
    const res = await app.request(
      `${pathA}/activity?briefId=${briefAId}`,
      withApexHost(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row[];
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((r) => r.briefId === briefAId)).toBe(true);
  });

  it("returns 404 for a briefId that doesn't exist in this Memex (std-7 cross-tenant)", async () => {
    // A spec living in memex B must not be addressable from memex A's path —
    // getDoc(memexA, ...) misses and throws NotFoundError → 404.
    const briefInB = await createDocDraft(memexB, "B-only Spec", "Purpose", "spec");
    createdDocIds.push(briefInB.id);

    const res = await app.request(
      `${pathA}/activity?briefId=${briefInB.id}`,
      withApexHost(),
    );
    expect(res.status).toBe(404);
  });

  it("filters by actorUserId", async () => {
    const byAlice = await seedActivity({
      memexId: memexA,
      actorUserId: alice,
      narrative: "alice acted",
    });
    const byBob = await seedActivity({
      memexId: memexA,
      actorUserId: bob,
      narrative: "bob acted",
    });

    const res = await app.request(
      `${pathA}/activity?actorUserId=${alice}&limit=200`,
      withApexHost(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row[];
    const ids = body.map((r) => r.id);
    expect(ids).toContain(byAlice.id);
    expect(ids).not.toContain(byBob.id);
    expect(body.every((r) => r.actorUserId === alice)).toBe(true);
  });

  it("filters by clientId", async () => {
    const fromCli = await seedActivity({
      memexId: memexA,
      clientId: "session-cli-123",
      narrative: "from cli session",
    });
    const fromOther = await seedActivity({
      memexId: memexA,
      clientId: "session-other-999",
      narrative: "from other session",
    });

    const res = await app.request(
      `${pathA}/activity?clientId=session-cli-123&limit=200`,
      withApexHost(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row[];
    const ids = body.map((r) => r.id);
    expect(ids).toContain(fromCli.id);
    expect(ids).not.toContain(fromOther.id);
    expect(body.every((r) => r.clientId === "session-cli-123")).toBe(true);
  });

  it("paginates with limit + since (keyset 'load older')", async () => {
    // A fresh sub-Memex so this test owns the entire timeline and ordering is
    // fully deterministic regardless of what other tests seeded.
    const p = await makeTestMemexWithDevAdmin("pulse-pg");
    memexIds.push(p.memexId);
    const pgPath = `/api/${p.slug}/main`;

    // Five rows with strictly increasing timestamps (clientId encodes order).
    const base = Date.now();
    const seeded: Row[] = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(
        await seedActivity({
          memexId: p.memexId,
          clientId: `evt-${i}`,
          narrative: `event ${i}`,
          createdAt: new Date(base + i * 1000),
        }),
      );
    }
    // Newest-first order: evt-4, evt-3, evt-2, evt-1, evt-0.

    // Page 1: limit=2 → the two newest.
    const res1 = await app.request(`${pgPath}/activity?limit=2`, withApexHost());
    expect(res1.status).toBe(200);
    const page1 = (await res1.json()) as Row[];
    expect(page1).toHaveLength(2);
    expect(page1.map((r) => r.clientId)).toEqual(["evt-4", "evt-3"]);

    // Page 2: since = last row's createdAt → the next two strictly-older rows.
    const cursor = page1[page1.length - 1].createdAt;
    const res2 = await app.request(
      `${pgPath}/activity?limit=2&since=${encodeURIComponent(cursor)}`,
      withApexHost(),
    );
    expect(res2.status).toBe(200);
    const page2 = (await res2.json()) as Row[];
    expect(page2).toHaveLength(2);
    expect(page2.map((r) => r.clientId)).toEqual(["evt-2", "evt-1"]);

    // No overlap between pages (since is an EXCLUSIVE boundary).
    const overlap = page1
      .map((r) => r.id)
      .filter((id) => page2.some((r) => r.id === id));
    expect(overlap).toHaveLength(0);
  });

  it("rejects a non-positive-integer limit with 400", async () => {
    const res = await app.request(`${pathA}/activity?limit=abc`, withApexHost());
    expect(res.status).toBe(400);
  });

  it("rejects a malformed since timestamp with 400", async () => {
    const res = await app.request(
      `${pathA}/activity?since=not-a-date`,
      withApexHost(),
    );
    expect(res.status).toBe(400);
  });

  // spec-199 t-6: authenticated org member receives all columns (no over-blocking).
  it("authenticated org member receives all columns including actorUserId, clientId, payload", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-199/acs/ac-6");
    // Seed a row with all sensitive fields populated.
    const row = await seedActivity({
      memexId: memexA,
      actorUserId: alice,
      clientId: "member-proj-test-client",
      payload: { detail: "internal data" },
      narrative: "member projection test",
    });

    const res = await app.request(`${pathA}/activity?limit=200`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row[];
    const found = body.find((r) => r.id === row.id);
    expect(found).toBeDefined();
    // Members must receive all three sensitive columns.
    expect(found).toHaveProperty("actorUserId", alice);
    expect(found).toHaveProperty("clientId", "member-proj-test-client");
    expect(found).toHaveProperty("payload");
  });
});
