// spec-407 t-1/t-3 — the BULK (whole-workspace) presence read.
//
//   ac-7  GET /presence with no `ref` returns whole-workspace presence (every
//         present spec in the Memex) in one request via listPresentForMemex;
//         the `?ref=<spec>` path is unchanged; a decayed row is excluded.
//   ac-8  the bulk read sits behind the standard session policy and is
//   ac-4  tenant-scoped — a second Memex's presence never appears in this one's
//         read (the path → memexId → memexId-filtered-rows chain; std-36).
//   ac-1  the "Working now" answer for many specs comes back in ONE request and
//   ac-2  is O(1) in the number of specs (no per-spec fan-out on the server).
//
// Mirrors activity.integration.test.ts's two-Memex harness. TAGGED with tagAc →
// reports to the PROD memex. Runs with MEMEX_EMIT_KEY set.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Force dev-mode auth so app.request() can resolve the tenant without a JWT
// (same shape as activity.integration.test.ts).
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { db } from "../db/connection.js";
import { users, documents, memexes, presence } from "../db/schema.js";
import { app } from "../app.js";
import { createDocDraft } from "../services/documents.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { PRESENCE_TTL_MS } from "../services/presence.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-407/acs";

// Path-based routing per std-2: memexResolver parses `/api/<slug>/main/...` from
// the URL with the apex Host.
function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

const createdUsers: string[] = [];
const createdDocs: string[] = [];
const memexIds: string[] = [];

let userId: string;
let pathA: string;
let memexA: string;
let pathB: string;
let memexB: string;
let specA1: { id: string; handle: string };
let specA2: { id: string; handle: string };
let specB1: { id: string; handle: string };

async function seedPresence(
  memexId: string,
  docId: string,
  clientId: string,
  lastSeenAt: Date,
): Promise<void> {
  await db.insert(presence).values({
    memexId,
    docId,
    actorUserId: userId,
    actorName: "Tester",
    actorKind: "human",
    channel: "rest_ui",
    clientId,
    lastSeenAt,
  } as typeof presence.$inferInsert);
}

beforeAll(async () => {
  // Per-worker-unique identifiers (std-37).
  const uniq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db
    .insert(users)
    .values({ email: `s407-${uniq}@memex.ai`, name: "Tester" } as typeof users.$inferInsert)
    .returning();
  userId = u.id;
  createdUsers.push(u.id);

  const a = await makeTestMemexWithDevAdmin("s407-a");
  memexA = a.memexId;
  pathA = `/api/${a.slug}/main`;
  memexIds.push(memexA);

  const b = await makeTestMemexWithDevAdmin("s407-b");
  memexB = b.memexId;
  pathB = `/api/${b.slug}/main`;
  memexIds.push(memexB);

  specA1 = await createDocDraft(memexA, "Spec A1", "A1", "spec");
  specA2 = await createDocDraft(memexA, "Spec A2", "A2", "spec");
  specB1 = await createDocDraft(memexB, "Spec B1", "B1", "spec");
  createdDocs.push(specA1.id, specA2.id, specB1.id);
});

afterAll(async () => {
  await db.delete(presence).where(inArray(presence.docId, createdDocs)).catch(() => {});
  if (createdDocs.length)
    await db.delete(documents).where(inArray(documents.id, createdDocs)).catch(() => {});
  if (memexIds.length) await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
  if (createdUsers.length)
    await db.delete(users).where(inArray(users.id, createdUsers)).catch(() => {});
});

interface ApiRow {
  docId: string;
  clientId: string;
}

describe("bulk presence read [spec-407 t-1]", () => {
  it("ac-7/ac-1/ac-2: GET /presence with no ref returns whole-workspace presence across multiple specs in one request", async () => {
    tagAc(`${AC}/ac-7`);
    tagAc(`${AC}/ac-1`);
    tagAc(`${AC}/ac-2`);

    // Present on two DIFFERENT specs in Memex A.
    await seedPresence(memexA, specA1.id, "tab-a1", new Date());
    await seedPresence(memexA, specA2.id, "tab-a2", new Date());

    const res = await app.request(`${pathA}/presence`, withApexHost());
    expect(res.status).toBe(200);
    const rows = (await res.json()) as ApiRow[];

    const docIds = new Set(rows.map((r) => r.docId));
    // BOTH specs answered by a SINGLE request — the per-spec fan-out is gone.
    expect(docIds.has(specA1.id)).toBe(true);
    expect(docIds.has(specA2.id)).toBe(true);
  });

  it("ac-7: a row past the TTL decays out of the bulk read", async () => {
    tagAc(`${AC}/ac-7`);
    await seedPresence(
      memexA,
      specA1.id,
      "tab-decayed",
      new Date(Date.now() - PRESENCE_TTL_MS - 5_000),
    );
    const res = await app.request(`${pathA}/presence`, withApexHost());
    const rows = (await res.json()) as ApiRow[];
    expect(rows.some((r) => r.clientId === "tab-decayed")).toBe(false);
  });

  it("ac-7: GET /presence?ref=<spec> still returns only that spec's presence", async () => {
    tagAc(`${AC}/ac-7`);
    await seedPresence(memexA, specA1.id, "ref-a1", new Date());
    await seedPresence(memexA, specA2.id, "ref-a2", new Date());

    const res = await app.request(`${pathA}/presence?ref=${specA1.handle}`, withApexHost());
    expect(res.status).toBe(200);
    const rows = (await res.json()) as ApiRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.docId === specA1.id)).toBe(true);
  });

  it("ac-8/ac-4: the bulk read is tenant-scoped — Memex B's presence never appears in Memex A's read", async () => {
    tagAc(`${AC}/ac-8`);
    tagAc(`${AC}/ac-4`);

    await seedPresence(memexB, specB1.id, "tab-b1", new Date());

    // A's read must not leak B.
    const resA = await app.request(`${pathA}/presence`, withApexHost());
    const rowsA = (await resA.json()) as ApiRow[];
    expect(rowsA.some((r) => r.docId === specB1.id)).toBe(false);
    expect(rowsA.some((r) => r.clientId === "tab-b1")).toBe(false);

    // B's own read DOES see B (proves the row exists and is scoped, not missing).
    const resB = await app.request(`${pathB}/presence`, withApexHost());
    const rowsB = (await resB.json()) as ApiRow[];
    expect(rowsB.some((r) => r.docId === specB1.id)).toBe(true);
  });
});
