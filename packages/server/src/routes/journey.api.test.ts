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
  tasks,
  testEventLatest,
  documents,
  memexes,
  namespaces,
  usageEvents,
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
const AC372 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;
// spec-336 — v2 arc: identity → create-spec → resolve-decision → add-ac →
// specs-match-reality → agents-build. ac-5 = each step advances automatically from the
// real, user-scoped signal; ac-8 = the full arc is presented to a new user.
const AC336 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-336/acs/ac-${n}`;

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
  // spec-307: the identity milestone keys off role_coords (placing yourself on the
  // triangle), NOT identity_confirmed_at. Mirror a real identity-step completion,
  // which stamps both (updateUserProfile).
  await db
    .update(users)
    .set({
      identityConfirmedAt: new Date(),
      roleCoords: { dev: 0.34, design: 0.33, pm: 0.33 },
    })
    .where(eq(users.id, userId));
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
async function seedTask(userId: string, docId: string) {
  await db.insert(tasks).values({
    memexId,
    docId,
    seq: 1,
    title: "Break out the work",
    description: "A task the user authored.",
    status: "not_started",
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
  it("a fresh user with no activity starts at the identity step, all milestones false", async () => {
    tagAc(AC336(5));
    tagAc(AC336(8));
    const user = await newUser();
    const { status, body } = await state(user.id);
    expect(status).toBe(200);
    // spec-336: the v2 arc opens on the identity ("About you") step, not a welcome card.
    expect(body.currentStepId).toBe("identity");
    expect(body.milestones).toEqual({
      identityConfirmed: false,
      mcpConnected: false,
      mcpToolCalled: false,
      hasSpec: false,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
      planGrounded: false,
    });
  });

  it("the identity tick reflects the triangle (role_coords), not the backfilled identity_confirmed_at (spec-307)", async () => {
    tagAc(AC(3));
    const user = await newUser();
    // A spec-305-backfilled user: identity_confirmed_at set (so they were never
    // force-onboarded) but they NEVER placed themselves on the triangle.
    await db.update(users).set({ identityConfirmedAt: new Date() }).where(eq(users.id, user.id));
    expect((await state(user.id)).body.milestones.identityConfirmed).toBe(false);
    // Completing the identity step saves role_coords → the tick goes green.
    await db
      .update(users)
      .set({ roleCoords: { dev: 0.5, design: 0.25, pm: 0.25 } })
      .where(eq(users.id, user.id));
    expect((await state(user.id)).body.milestones.identityConfirmed).toBe(true);
  });

  it("anonymous requests are rejected", async () => {
    tagAc(AC(3));
    const res = await app.request("/api/me/journey-state");
    expect(res.status).toBe(401);
  });
});

describe("Home Canvas journey-state (ac-5 self-advance through the v2 arc)", () => {
  it("advances one step at a time through the whole six-step arc", async () => {
    tagAc(AC336(5));
    tagAc(AC336(8));
    const user = await newUser();
    expect((await state(user.id)).body.currentStepId).toBe("identity");

    await confirmIdentity(user.id);
    // spec-336: connect is folded into the create-spec card (Stage 1) — connecting is
    // shown inline, but the STEP advances on hasSpec, so identity → create-spec directly.
    expect((await state(user.id)).body.currentStepId).toBe("create-spec");

    await connectMcp(user.id);
    // mcpConnected no longer gates a dedicated step — still on create-spec until a spec exists.
    expect((await state(user.id)).body.currentStepId).toBe("create-spec");

    const doc = await seedSpec(user.id);
    expect((await state(user.id)).body.currentStepId).toBe("resolve-decision");

    await seedResolvedDecision(user.id, doc.id);
    expect((await state(user.id)).body.currentStepId).toBe("add-ac");

    await seedAc(user.id, doc.id);
    // Next is the builder-only 'Specs that match reality', gated on planGrounded.
    expect((await state(user.id)).body.currentStepId).toBe("specs-match-reality");

    // planGrounded = tasks broken out AND a test behind one of the user's ACs (spec-337).
    await seedTask(user.id, doc.id);
    await seedGreen(doc.id);
    expect((await state(user.id)).body.currentStepId).toBe("agents-build"); // terminal
  });

  it("is hard-gated: a later milestone without its predecessor does not skip ahead", async () => {
    tagAc(AC336(5));
    const user = await newUser();
    // A spec exists, but identity is not confirmed → still at the very first step.
    await seedSpec(user.id);
    const { body } = await state(user.id);
    expect(body.currentStepId).toBe("identity");
    expect(body.milestones.hasSpec).toBe(true);
    expect(body.milestones.identityConfirmed).toBe(false);
  });

  it("milestones are user-scoped: another user's spec does not advance this user", async () => {
    tagAc(AC336(5));
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
      body: JSON.stringify({ action: "shown", step: "create-spec" }),
    });
    expect(shown.status).toBe(200);
    const clicked = await app.request("/api/me/journey-event", {
      method: "POST",
      headers: { ...auth(user.id), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cta", step: "create-spec", cta: "copy_prompt" }),
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

  // spec-372 dec-6 Layer C — the persona action records home_canvas.persona_selected with
  // the resolved persona label only (never raw coords).
  it("records persona_selected with the resolved persona label (spec-372 ac-22)", async () => {
    tagAc(AC372(22));
    const user = await newUser();
    const res = await app.request("/api/me/journey-event", {
      method: "POST",
      headers: { ...auth(user.id), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "persona", step: "identity", persona: "Builder" }),
    });
    expect(res.status).toBe(200);
    const rows = await db
      .select({ name: usageEvents.name, props: usageEvents.props })
      .from(usageEvents)
      .where(eq(usageEvents.actorUserId, user.id));
    const persona = rows.find((r) => r.name === "home_canvas.persona_selected");
    expect(persona).toBeTruthy();
    expect((persona?.props as { persona?: string } | null)?.persona).toBe("Builder");
  });
});

// spec-337 — planGrounded: the codebase-grounding milestone for the builder-only
// 'Specs that match reality' step. Derived the same way as the others: user-scoped
// counts over the acting user's own rows, demo-excluded. Ticks only when the user
// has BOTH broken the work into tasks AND has a test behind one of their ACs.
const AC337 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-337/acs/ac-${n}`;

describe("journey-state planGrounded (spec-337)", () => {
  it("is false until BOTH a task and an AC-with-a-test exist (ac-1, ac-4)", async () => {
    tagAc(AC337(1));
    tagAc(AC337(4));
    const user = await newUser();
    const doc = await seedSpec(user.id);
    expect((await state(user.id)).body.milestones.planGrounded).toBe(false);

    await seedTask(user.id, doc.id); // tasks only → still false
    expect((await state(user.id)).body.milestones.planGrounded).toBe(false);

    await seedAc(user.id, doc.id);
    await seedGreen(doc.id); // a test event now exists on the user's AC (any status)
    expect((await state(user.id)).body.milestones.planGrounded).toBe(true);
  });

  it("an AC-with-a-test but no tasks does not set it (ac-4)", async () => {
    tagAc(AC337(4));
    const user = await newUser();
    const doc = await seedSpec(user.id);
    await seedAc(user.id, doc.id);
    await seedGreen(doc.id);
    expect((await state(user.id)).body.milestones.planGrounded).toBe(false);
  });

  it("is user-scoped: a colleague's task + AC-test does not set mine (ac-1, ac-3)", async () => {
    tagAc(AC337(1));
    tagAc(AC337(3));
    const me = await newUser();
    const colleague = await newUser();
    const doc = await seedSpec(colleague.id);
    await seedTask(colleague.id, doc.id);
    await seedAc(colleague.id, doc.id);
    await seedGreen(doc.id);
    expect((await state(me.id)).body.milestones.planGrounded).toBe(false);
    expect((await state(colleague.id)).body.milestones.planGrounded).toBe(true);
  });

  it("excludes demo content: a task + AC-test on a demo spec do not count (ac-3, ac-5)", async () => {
    tagAc(AC337(3));
    tagAc(AC337(5));
    const user = await newUser();
    const doc = await seedSpec(user.id);
    await db.update(documents).set({ isDemo: true }).where(eq(documents.id, doc.id));
    await seedTask(user.id, doc.id);
    await seedAc(user.id, doc.id);
    await seedGreen(doc.id);
    expect((await state(user.id)).body.milestones.planGrounded).toBe(false);
  });
});
