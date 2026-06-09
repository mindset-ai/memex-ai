// Integration tests for the first-run greeting gate (spec-206 t-1).
//
//   GET  /api/onboarding/greeting  → { greet, firstName }  (ac-13)
//   POST /api/onboarding/greeting  → stamps onboarding_greeted_at (ac-14)
//
// ac-12 — the nullable onboarding_greeted_at column exists and defaults null for
//         a fresh user (proven by reading the row straight after upsert).
// ac-13 — greet is true iff onboarding_greeted_at IS NULL.
// ac-14 — the stamp is idempotent (first greeting wins) and scoped to the current
//         user, so the greeting never re-fires (any device); anonymous → 401.
//
// Runs against a REAL Postgres through the full Hono app + strict sessionMiddleware.

import { describe, it, expect, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";

vi.hoisted(() => {
  // Force auth-mode session middleware so per-user Bearer tokens are honored
  // (mirrors handhold.api.test.ts). Without GOOGLE_CLIENT_ID the middleware
  // falls into dev-mode and authenticates everyone as dev@memex.ai.
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import {
  upsertUserByEmail,
  updateUserProfile,
  getUserById,
} from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-206/acs/ac-${n}`;

const createdUserIds: string[] = [];

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function makeUser(prefix: string, name?: string) {
  const user = await upsertUserByEmail(uniqueEmail(prefix));
  if (name) await updateUserProfile(user.id, { name });
  createdUserIds.push(user.id);
  return { id: user.id, bearer: signSessionToken(user.id) };
}

function getGreeting(bearer?: string) {
  const headers = new Headers();
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  return app.request("/api/onboarding/greeting", { headers });
}

function postGreeting(bearer?: string) {
  const headers = new Headers();
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  return app.request("/api/onboarding/greeting", { method: "POST", headers });
}

afterAll(async () => {
  if (createdUserIds.length) {
    // Deleting the user cascades its lazily-provisioned namespace/memex/docs.
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("first-run greeting gate (spec-206 t-1)", () => {
  it("a fresh user's onboarding_greeted_at column exists and defaults null", async () => {
    tagAc(AC(12));
    const { id } = await makeUser("sp206-col");
    const row = await getUserById(id);
    // Column is present (typed access compiles) and null for a never-greeted user.
    expect(row).toBeTruthy();
    expect(row!.onboardingGreetedAt).toBeNull();
  });

  it("GET returns greet=true while ungreeted, greet=false once stamped", async () => {
    tagAc(AC(13));
    const { id, bearer } = await makeUser("sp206-gate", "Ryan Soosayraj");

    const before = await getGreeting(bearer);
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody.greet).toBe(true);
    // firstName is the first token of users.name (sanity; ac-10 owned by t-3).
    expect(beforeBody.firstName).toBe("Ryan");

    // Establish the session (lazy-provision) is already done; now stamp.
    const stamp = await postGreeting(bearer);
    expect(stamp.status).toBe(200);

    const after = await getGreeting(bearer);
    const afterBody = await after.json();
    expect(afterBody.greet).toBe(false);

    // Sanity: the column actually carries a timestamp now.
    const row = await getUserById(id);
    expect(row!.onboardingGreetedAt).toBeInstanceOf(Date);
  });

  it("POST is idempotent (first greeting wins) and isolated per user; anonymous → 401", async () => {
    tagAc(AC(14));
    const a = await makeUser("sp206-a");
    const b = await makeUser("sp206-b");

    // First stamp on A.
    expect((await postGreeting(a.bearer)).status).toBe(200);
    const firstTs = (await getUserById(a.id))!.onboardingGreetedAt;
    expect(firstTs).toBeInstanceOf(Date);

    // Second stamp on A is a no-op — the original timestamp is preserved
    // (greeting never re-fires, on this device or another).
    expect((await postGreeting(a.bearer)).status).toBe(200);
    const secondTs = (await getUserById(a.id))!.onboardingGreetedAt;
    expect(secondTs!.getTime()).toBe(firstTs!.getTime());

    // B was never stamped by A's calls — cross-user isolation.
    expect((await getUserById(b.id))!.onboardingGreetedAt).toBeNull();
    const bGate = await getGreeting(b.bearer);
    expect((await bGate.json()).greet).toBe(true);

    // Anonymous (no Bearer) is 401'd before the handler — cannot read or stamp.
    expect((await getGreeting()).status).toBe(401);
    expect((await postGreeting()).status).toBe(401);
  });
});
