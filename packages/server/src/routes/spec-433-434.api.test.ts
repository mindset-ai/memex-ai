// Integration tests for spec-434 (hide Specky for new users until MCP connected + first spec).
//
// spec-434:
//   ac-1  — new user: no auto-greeting, no voice session initiated
//   ac-2  — Specky activates normally for graduated users (mcpConnected AND hasSpec)
//   ac-3  — pre-existing greeted users see no change in Specky's behaviour
//   ac-5  — GET /api/onboarding/greeting returns greet=false for an ungreeted user who
//           has NOT yet connected MCP.
//   ac-6  — GET returns greet=true for an ungreeted user who HAS connected MCP AND hasSpec.
//
// Runs against a REAL Postgres through the full Hono app + strict sessionMiddleware.

import { describe, it, expect, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users, documents } from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { recordMcpConnected } from "../services/funnel-events.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC434 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-434/acs/ac-${n}`;

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@spec433434.test`;
}

async function makeUser(prefix: string) {
  const user = await upsertUserByEmail(uniqueEmail(prefix));
  createdUserIds.push(user.id);
  return { id: user.id, bearer: signSessionToken(user.id) };
}

function getGreeting(bearer?: string) {
  const headers = new Headers();
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  return app.request("/api/onboarding/greeting", { headers });
}

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

// ── spec-434 ─────────────────────────────────────────────────────────────────

describe("spec-434: greeting gate requires mcpConnected AND hasSpec", () => {
  it("returns greet=false for an ungreeted user with no MCP connection and no spec", async () => {
    tagAc(AC434(5));
    tagAc(AC434(1)); // new user: no auto-greeting, no voice session initiated
    const { bearer } = await makeUser("sp434-fresh");
    const res = await getGreeting(bearer);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.greet).toBe(false);
  });

  it("returns greet=false for an ungreeted user with MCP connected but no spec", async () => {
    tagAc(AC434(5));
    tagAc(AC434(1));
    const { id, bearer } = await makeUser("sp434-mcp-only");
    await recordMcpConnected(id);
    const res = await getGreeting(bearer);
    expect((await res.json()).greet).toBe(false);
  });

  it("returns greet=true for an ungreeted user with MCP connected AND a spec created", async () => {
    tagAc(AC434(6));
    tagAc(AC434(2)); // Specky activates normally for graduated users
    const { id, bearer } = await makeUser("sp434-graduated");
    await recordMcpConnected(id);

    // Seed a real spec document in a test memex owned by this user.
    const memexId = await makeTestMemex("sp434");
    createdMemexIds.push(memexId);
    await db.insert(documents).values({
      memexId,
      title: "Test spec for greeting gate",
      status: "draft",
      handle: "spec-1",
      docType: "spec",
      isDemo: false,
      createdByUserId: id,
      statusChangedAt: new Date(),
    });

    const res = await getGreeting(bearer);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.greet).toBe(true);
  });

  it("returns greet=false once already stamped, even if mcpConnected and hasSpec", async () => {
    tagAc(AC434(6));
    tagAc(AC434(3)); // pre-existing greeted users see no change in Specky's behaviour
    const { id, bearer } = await makeUser("sp434-already-greeted");
    await recordMcpConnected(id);

    const memexId = await makeTestMemex("sp434b");
    createdMemexIds.push(memexId);
    await db.insert(documents).values({
      memexId,
      title: "Test spec",
      status: "draft",
      handle: "spec-1",
      docType: "spec",
      isDemo: false,
      createdByUserId: id,
      statusChangedAt: new Date(),
    });

    // First call: greet=true; stamp it.
    expect((await (await getGreeting(bearer)).json()).greet).toBe(true);
    await app.request("/api/onboarding/greeting", {
      method: "POST",
      headers: new Headers({ Authorization: `Bearer ${bearer}` }),
    });

    // After stamp: greet=false.
    expect((await (await getGreeting(bearer)).json()).greet).toBe(false);
  });
});
