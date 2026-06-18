// spec-305 — Home Canvas journey-state API (integration). Supersedes spec-303's
// journey test: the journey is MCP-first and ends at a GREEN acceptance criterion.
//
// ac-3  — the current step is DERIVED from the user's real milestones: a fresh user
//         is at 'welcome'; completed steps are never the current step.
// ac-4  — the journey self-advances as milestones are met, hard-gated + user-scoped.
// ac-9  — connect-agent precedes create-spec (MCP-first ordering).
// ac-11 — milestones are counted from the ACTING user's own rows.
// ac-13 — resolved-decision / AC-exists / AC-verified are real derived milestones;
//         the terminal step is gated on a GREEN AC (acVerified).
// ac-7  — the canvas records which step was shown and which CTA was taken.
//
// Runs against a REAL Postgres through the full Hono app + strict sessionMiddleware.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import {
  users,
  decisions,
  acs,
  testEventLatest,
  documents,
  memexes,
  namespaces,
  type User,
} from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { recordUsageEvent } from "../services/usage-events.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { createDecision } from "../services/decisions.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-305/acs/ac-${n}`;

let memexId: string;
// Every newUser() spins up a personal namespace + memex (kind='user'). Track them
// so afterAll can tear them down: whole-DB-scan tests elsewhere in the suite
// (handhold's backfillHandholdDemo scans ALL personal memexes; migration-smoke
// scans ALL active users) would otherwise trip on this file's residue when the
// vitest worker co-locates them. Leave no globally-scannable rows behind.
const createdUserIds: string[] = [];
beforeAll(async () => {
  memexId = await makeTestMemex("homecanvas305");
});
afterAll(async () => {
  if (createdUserIds.length === 0) return;
  // Deleting each user's owned namespace cascades to its memexes → docs → acs /
  // decisions (FK onDelete: 'cascade'); then drop the user rows themselves.
  await db.delete(namespaces).where(inArray(namespaces.ownerUserId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

function auth(userId: string): Record<string, string> {
  return { Authorization: `Bearer ${signSessionToken(userId)}` };
}
async function newUser(domain = "example.com"): Promise<User> {
  const user = await upsertUserByEmail(`hc-${randomUUID()}@${domain}`);
  createdUserIds.push(user.id);
  return user;
}
async function state(userId: string, query = ""): Promise<{ status: number; body: any }> {
  const res = await app.request(`/api/me/journey-state${query}`, { headers: auth(userId) });
  return { status: res.status, body: await res.json() };
}

// ── milestone seeders (each a USER-scoped fact the engine derives from) ──
async function confirmIdentity(userId: string) {
  await db.update(users).set({ identityConfirmedAt: new Date() }).where(eq(users.id, userId));
}
async function connectMcp(userId: string) {
  await recordUsageEvent({ memexId: null, actorUserId: userId, name: "mcp.connected", source: "backend" });
}
async function seedSpec(userId: string) {
  return createDocDraft(memexId, "Seed spec", "Purpose", "spec", undefined, undefined, userId, {
    actorUserId: userId,
  });
}
async function seedResolvedDecision(userId: string, docId: string) {
  await createDecision(memexId, docId, "A decision", undefined, "human", { actorUserId: userId });
  await db.update(decisions).set({ status: "resolved" }).where(eq(decisions.actorUserId, userId));
}
async function seedAc(userId: string, docId: string) {
  await db.insert(acs).values({
    memexId,
    briefId: docId,
    seq: 1,
    kind: "scope",
    statement: "Done means the thing works.",
    status: "active",
    actorUserId: userId,
  });
}
async function seedGreen(docId: string) {
  const [slugs] = await db
    .select({ ns: namespaces.slug, mx: memexes.slug, handle: documents.handle })
    .from(documents)
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(documents.id, docId));
  const acUid = `${slugs.ns}/${slugs.mx}/specs/${slugs.handle}/acs/ac-1`;
  await db.insert(testEventLatest).values({
    acUid,
    testIdentifier: "t1",
    latestStatus: "pass",
    latestRunAt: new Date(),
    runCount: 1,
  });
}

describe("Home Canvas journey-state (ac-3 derived position)", () => {
  it("a fresh user with no activity is at the welcome step, all milestones false", async () => {
    tagAc(AC(3));
    tagAc(AC(10));
    const user = await newUser();
    const { status, body } = await state(user.id);
    expect(status).toBe(200);
    expect(body.currentStepId).toBe("welcome");
    expect(body.milestones).toEqual({
      identityConfirmed: false,
      mcpConnected: false,
      mcpToolCalled: false,
      hasSpec: false,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
    });
  });

  it("anonymous requests are rejected", async () => {
    tagAc(AC(3));
    const res = await app.request("/api/me/journey-state");
    expect(res.status).toBe(401);
  });
});

describe("Home Canvas journey-state (ac-4 self-advance, MCP-first, to a green AC)", () => {
  it("advances one hard-gated step at a time through the whole arc", async () => {
    tagAc(AC(4));
    tagAc(AC(9)); // connect-agent precedes create-spec
    tagAc(AC(13)); // resolved-decision / AC / green are real milestones
    const user = await newUser();
    expect((await state(user.id)).body.currentStepId).toBe("welcome");

    await confirmIdentity(user.id);
    expect((await state(user.id)).body.currentStepId).toBe("connect-agent"); // MCP-first

    await connectMcp(user.id);
    expect((await state(user.id)).body.currentStepId).toBe("create-spec");

    const doc = await seedSpec(user.id);
    expect((await state(user.id)).body.currentStepId).toBe("resolve-decision");

    await seedResolvedDecision(user.id, doc.id);
    expect((await state(user.id)).body.currentStepId).toBe("add-ac");

    await seedAc(user.id, doc.id);
    expect((await state(user.id)).body.currentStepId).toBe("see-green");

    await seedGreen(doc.id);
    expect((await state(user.id)).body.currentStepId).toBe("all-set");
  });

  it("is hard-gated: a later milestone without its predecessor does not skip ahead", async () => {
    tagAc(AC(4));
    const user = await newUser();
    // A spec exists, but identity is not confirmed → still at the very first step.
    await seedSpec(user.id);
    const { body } = await state(user.id);
    expect(body.currentStepId).toBe("welcome");
    expect(body.milestones.hasSpec).toBe(true);
    expect(body.milestones.identityConfirmed).toBe(false);
  });

  it("milestones are user-scoped: another user's spec does not advance this user", async () => {
    tagAc(AC(4));
    tagAc(AC(11));
    const me = await newUser();
    const colleague = await newUser();
    await confirmIdentity(me.id);
    await connectMcp(me.id);
    await seedSpec(colleague.id); // the colleague's spec, not mine
    expect((await state(me.id)).body.currentStepId).toBe("create-spec");
  });
});

describe("Home Canvas journey-state (ac-7 measurement)", () => {
  it("records which step was shown and which CTA was taken", async () => {
    tagAc(AC(7));
    const user = await newUser();
    const shown = await app.request("/api/me/journey-event", {
      method: "POST",
      headers: { ...auth(user.id), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "shown", step: "connect-agent" }),
    });
    expect(shown.status).toBe(200);
    const clicked = await app.request("/api/me/journey-event", {
      method: "POST",
      headers: { ...auth(user.id), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cta", step: "connect-agent", cta: "connect_agent" }),
    });
    expect(clicked.status).toBe(200);
  });

  it("rejects a malformed journey event", async () => {
    tagAc(AC(7));
    const user = await newUser();
    const res = await app.request("/api/me/journey-event", {
      method: "POST",
      headers: { ...auth(user.id), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "bogus", step: "welcome" }),
    });
    expect(res.status).toBe(400);
  });
});
