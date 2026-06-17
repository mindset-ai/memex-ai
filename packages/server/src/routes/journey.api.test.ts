// spec-303 — Home Canvas journey-state API (integration).
//
// ac-3 — the current step is DERIVED from the user's real milestones (dec-3): a
//        fresh user is at 'welcome'; completed steps are never the current step.
// ac-4 — the journey self-advances as milestones are met, and is hard-gated +
//        user-scoped (dec-4): an MCP-connected user with no spec is still 'welcome'.
// ac-5 — a fully-activated user lands on the terminal 'all-set' step.
// ac-6 — an operator can ?preview=<step> to pin the canvas to any state on their
//        own account; a non-operator's preview is ignored (dec-8/dec-9).
// ac-7 — the canvas records which step was shown and which CTA was taken.
//
// Runs against a REAL Postgres through the full Hono app + strict sessionMiddleware.
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.hoisted(() => {
  // Force auth-mode session middleware so per-user Bearer tokens are honored
  // (mirrors onboarding.api.test.ts). Without GOOGLE_CLIENT_ID the middleware
  // falls into dev-mode and authenticates everyone as dev@memex.ai.
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import { usageEvents, type User } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { upsertUserByEmail } from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { recordUsageEvent } from "../services/usage-events.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { createDecision } from "../services/decisions.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-303/acs/ac-${n}`;

// A shared container memex — milestones are USER-scoped (dec-4), so docs created
// here but attributed to different fresh users measure each user independently.
let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex("homecanvas");
});

const PREVIEW_ENV = process.env.JOURNEY_PREVIEW_DOMAINS;
afterEach(() => {
  if (PREVIEW_ENV === undefined) delete process.env.JOURNEY_PREVIEW_DOMAINS;
  else process.env.JOURNEY_PREVIEW_DOMAINS = PREVIEW_ENV;
});

function auth(userId: string): Record<string, string> {
  return { Authorization: `Bearer ${signSessionToken(userId)}` };
}

async function newUser(domain = "example.com"): Promise<User> {
  return upsertUserByEmail(`hc-${randomUUID()}@${domain}`);
}

async function seedSpec(userId: string): Promise<void> {
  await createDocDraft(memexId, "Seed spec", "Purpose", "spec", undefined, undefined, userId, {
    actorUserId: userId,
  });
}

async function seedDecision(userId: string): Promise<void> {
  const doc = await createDocDraft(
    memexId,
    "Seed doc",
    "Purpose",
    "document",
    undefined,
    undefined,
    userId,
    { actorUserId: userId },
  );
  await createDecision(memexId, doc.id, "A decision", undefined, "human", {
    actorUserId: userId,
  });
}

async function state(
  userId: string,
  query = "",
): Promise<{ status: number; body: any }> {
  const res = await app.request(`/api/me/journey-state${query}`, {
    headers: auth(userId),
  });
  return { status: res.status, body: await res.json() };
}

describe("Home Canvas journey-state (ac-3 derived position)", () => {
  it("a fresh user with no activity is at the welcome step, all milestones false", async () => {
    tagAc(AC(3));
    tagAc(AC(10)); // impl dec-3: currentStepId is derived from milestones, no cursor
    const user = await newUser();
    const { status, body } = await state(user.id);
    expect(status).toBe(200);
    expect(body.currentStepId).toBe("welcome");
    expect(body.milestones).toEqual({
      hasSpec: false,
      hasDecision: false,
      mcpConnected: false,
      mcpToolCalled: false,
    });
    expect(body.preview).toBe(false);
  });

  it("anonymous requests are rejected", async () => {
    tagAc(AC(3));
    const res = await app.request("/api/me/journey-state");
    expect(res.status).toBe(401);
  });
});

describe("Home Canvas journey-state (ac-4 self-advance, hard-gated, user-scoped)", () => {
  it("advances one hard-gated step at a time as the user's own milestones are met", async () => {
    tagAc(AC(4));
    const user = await newUser();
    expect((await state(user.id)).body.currentStepId).toBe("welcome");

    await seedSpec(user.id);
    expect((await state(user.id)).body.currentStepId).toBe("first-decision");

    await seedDecision(user.id);
    expect((await state(user.id)).body.currentStepId).toBe("connect-agent");

    await recordUsageEvent({
      memexId: null,
      actorUserId: user.id,
      name: "mcp.connected",
      source: "backend",
    });
    expect((await state(user.id)).body.currentStepId).toBe("use-agent");
  });

  it("is hard-gated: a later milestone without its predecessor does NOT skip the user ahead", async () => {
    tagAc(AC(4));
    const user = await newUser();
    // MCP connected + a tool called, but no spec yet → still at the very first step.
    await recordUsageEvent({
      memexId: null,
      actorUserId: user.id,
      name: "mcp.connected",
      source: "backend",
    });
    await recordUsageEvent({
      memexId: null,
      actorUserId: user.id,
      name: "mcp.tool_called",
      source: "backend",
    });
    const { body } = await state(user.id);
    expect(body.currentStepId).toBe("welcome");
    expect(body.milestones.mcpConnected).toBe(true);
    expect(body.milestones.hasSpec).toBe(false);
  });

  it("milestones are user-scoped: another user's spec does not advance this user", async () => {
    tagAc(AC(4));
    tagAc(AC(11)); // impl dec-4: milestones counted from the acting user's own rows
    const me = await newUser();
    const colleague = await newUser();
    await seedSpec(colleague.id);
    expect((await state(me.id)).body.currentStepId).toBe("welcome");
  });
});

describe("Home Canvas journey-state (ac-5 terminal step)", () => {
  it("a fully-activated user lands on 'all-set'", async () => {
    tagAc(AC(5));
    const user = await newUser();
    await seedSpec(user.id);
    await seedDecision(user.id);
    await recordUsageEvent({
      memexId: null,
      actorUserId: user.id,
      name: "mcp.connected",
      source: "backend",
    });
    await recordUsageEvent({
      memexId: null,
      actorUserId: user.id,
      name: "mcp.tool_called",
      source: "backend",
    });
    const { body } = await state(user.id);
    expect(body.currentStepId).toBe("all-set");
    expect(body.milestones).toEqual({
      hasSpec: true,
      hasDecision: true,
      mcpConnected: true,
      mcpToolCalled: true,
    });
  });
});

describe("Home Canvas journey-state (ac-6 operator preview)", () => {
  it("an operator (email domain in deploy config) can pin any step on their own account, real state untouched", async () => {
    tagAc(AC(6));
    tagAc(AC(15)); // impl dec-8: ?preview pins currentStepId, real milestones untouched
    tagAc(AC(16)); // impl dec-9: capability from JOURNEY_PREVIEW_DOMAINS deploy config
    process.env.JOURNEY_PREVIEW_DOMAINS = "previewtest.local";
    const user = await newUser("previewtest.local");
    const { body } = await state(user.id, "?preview=use-agent");
    expect(body.canPreview).toBe(true);
    expect(body.preview).toBe(true);
    expect(body.currentStepId).toBe("use-agent");
    // Real milestones are untouched — preview is render-only.
    expect(body.milestones.hasSpec).toBe(false);
  });

  it("a non-operator cannot force a state: their preview is ignored and they get the truth", async () => {
    tagAc(AC(6));
    tagAc(AC(16)); // impl dec-9: a domain outside the deploy-config allow-list is not entitled
    process.env.JOURNEY_PREVIEW_DOMAINS = "previewtest.local";
    const user = await newUser("example.com"); // not in the allow-list
    const { body } = await state(user.id, "?preview=all-set");
    expect(body.canPreview).toBe(false);
    expect(body.preview).toBe(false);
    expect(body.currentStepId).toBe("welcome");
  });

  it("an unknown step id is ignored even for an operator", async () => {
    tagAc(AC(6));
    process.env.JOURNEY_PREVIEW_DOMAINS = "previewtest.local";
    const user = await newUser("previewtest.local");
    const { body } = await state(user.id, "?preview=not-a-step");
    expect(body.preview).toBe(false);
    expect(body.currentStepId).toBe("welcome");
  });
});

describe("Home Canvas journey-state (ac-7 measurement)", () => {
  it("records which step was shown and which CTA was taken", async () => {
    tagAc(AC(7));
    const user = await newUser();
    const shown = await app.request("/api/me/journey-event", {
      method: "POST",
      headers: { ...auth(user.id), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "shown", step: "welcome" }),
    });
    expect(shown.status).toBe(200);
    const clicked = await app.request("/api/me/journey-event", {
      method: "POST",
      headers: { ...auth(user.id), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cta", step: "welcome", cta: "create_spec" }),
    });
    expect(clicked.status).toBe(200);

    const rows = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.actorUserId, user.id));
    const names = rows.map((r) => r.name).sort();
    expect(names).toContain("home_canvas.step_shown");
    expect(names).toContain("home_canvas.cta_clicked");
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
