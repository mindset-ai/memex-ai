// spec-574 — PATCH /api/auth/profile/avatar: a person nominates the letters their
// avatar shows, or clears them.
//
// Runs against a REAL Postgres through the full Hono app + strict sessionMiddleware,
// because the claims are about what lands in `users` (the nominated letters) and what
// must NOT (the display name and the onboarding identity stamp, which the sibling
// PATCH /api/auth/profile rewrites on every call).
import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { namespaces, users, type User } from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-574";
const AC_ROUTE = `${SPEC}/acs/ac-8`;
const AC_REFUSED = `${SPEC}/acs/ac-3`;

const createdUserIds: string[] = [];
afterAll(async () => {
  if (createdUserIds.length === 0) return;
  await db.delete(namespaces).where(inArray(namespaces.ownerUserId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

async function newUser(name: string | null = "Avatar Person"): Promise<User> {
  // std-37 cl-1: unique per worker and per call.
  const user = await upsertUserByEmail(`av-${randomUUID()}@example.com`);
  createdUserIds.push(user.id);
  // Set directly: updateUserProfile would stamp identity_confirmed_at, which one of
  // these tests asserts the avatar route leaves alone.
  const [named] = await db.update(users).set({ name }).where(eq(users.id, user.id)).returning();
  return named!;
}

function patchAvatar(userId: string | null, body: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userId) headers.Authorization = `Bearer ${signSessionToken(userId)}`;
  return app.request("/api/auth/profile/avatar", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

async function row(userId: string) {
  const [r] = await db.select().from(users).where(eq(users.id, userId));
  return r!;
}

describe("PATCH /api/auth/profile/avatar", () => {
  it("stores the normalised letters and returns them on the refreshed session", async () => {
    tagAc(AC_ROUTE);
    const user = await newUser();
    const res = await patchAvatar(user.id, { avatarLabel: " wv " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.avatarLabel).toBe("WV");
    expect((await row(user.id)).avatarLabel).toBe("WV");

    // The session read path carries it too, not just the write response.
    const me = await app.request("/api/auth/me", {
      headers: { Authorization: `Bearer ${signSessionToken(user.id)}` },
    });
    expect((await me.json()).user.avatarLabel).toBe("WV");
  });

  it("clears the letters with null, returning the person to the automatic rule", async () => {
    tagAc(AC_ROUTE);
    const user = await newUser();
    await patchAvatar(user.id, { avatarLabel: "WV" });
    const res = await patchAvatar(user.id, { avatarLabel: null });
    expect(res.status).toBe(200);
    expect((await res.json()).user.avatarLabel).toBeNull();
    expect((await row(user.id)).avatarLabel).toBeNull();
  });

  it("changes neither the display name nor the onboarding identity stamp", async () => {
    tagAc(AC_ROUTE);
    const user = await newUser("Kept Name");
    const before = await row(user.id);
    // Precondition: a fresh user has not confirmed identity, so a stamp would be visible.
    expect(before.identityConfirmedAt).toBeNull();

    await patchAvatar(user.id, { avatarLabel: "KN" });
    const after = await row(user.id);
    expect(after.name).toBe("Kept Name");
    expect(after.identityConfirmedAt).toBeNull();
  });

  it.each([
    ["three letters", "abc"],
    ["a digit", "W1"],
    ["a non-string", 7],
  ])("refuses %s with 400 naming the rule, and stores nothing", async (_label, value) => {
    tagAc(AC_ROUTE);
    tagAc(AC_REFUSED);
    const user = await newUser();
    await patchAvatar(user.id, { avatarLabel: "OK" });
    const res = await patchAvatar(user.id, { avatarLabel: value });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/one or two letters/i);
    expect((await row(user.id)).avatarLabel).toBe("OK");
  });

  it("refuses a body with no avatarLabel key rather than silently clearing", async () => {
    tagAc(AC_ROUTE);
    const user = await newUser();
    await patchAvatar(user.id, { avatarLabel: "OK" });
    const res = await patchAvatar(user.id, {});
    expect(res.status).toBe(400);
    expect((await row(user.id)).avatarLabel).toBe("OK");
  });

  it("requires a session", async () => {
    tagAc(AC_ROUTE);
    const res = await patchAvatar(null, { avatarLabel: "WV" });
    expect(res.status).toBe(401);
  });
});

const AC_COLOR = `${SPEC}/acs/ac-14`;

describe("PATCH /api/auth/profile/avatar: colour", () => {
  it("stores a palette colour without touching the letters, and the reverse", async () => {
    tagAc(AC_COLOR);
    const user = await newUser();
    await patchAvatar(user.id, { avatarLabel: "WV" });

    const res = await patchAvatar(user.id, { avatarColor: "Teal" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.avatarColor).toBe("teal");
    expect(body.user.avatarLabel).toBe("WV");
    expect(await row(user.id)).toMatchObject({ avatarLabel: "WV", avatarColor: "teal" });

    await patchAvatar(user.id, { avatarLabel: "XY" });
    expect(await row(user.id)).toMatchObject({ avatarLabel: "XY", avatarColor: "teal" });
  });

  it("sets both in one request, and clears the colour back to the default with null", async () => {
    tagAc(AC_COLOR);
    const user = await newUser();
    await patchAvatar(user.id, { avatarLabel: "AB", avatarColor: "red" });
    expect(await row(user.id)).toMatchObject({ avatarLabel: "AB", avatarColor: "red" });

    const res = await patchAvatar(user.id, { avatarColor: null });
    expect(res.status).toBe(200);
    expect((await res.json()).user.avatarColor).toBeNull();
    expect(await row(user.id)).toMatchObject({ avatarLabel: "AB", avatarColor: null });
  });

  it.each([["an unknown colour", "chartreuse"], ["a hex value", "#ff0000"]])(
    "refuses %s with 400 naming the palette, and stores nothing",
    async (_label, value) => {
      tagAc(AC_COLOR);
      const user = await newUser();
      await patchAvatar(user.id, { avatarLabel: "OK", avatarColor: "blue" });
      const res = await patchAvatar(user.id, { avatarLabel: "ZZ", avatarColor: value });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/avatar colour must be one of/i);
      // A refused request writes nothing, including its valid letters.
      expect(await row(user.id)).toMatchObject({ avatarLabel: "OK", avatarColor: "blue" });
    },
  );

  it("a new user has no colour and no letters on their session", async () => {
    tagAc(AC_COLOR);
    const user = await newUser();
    const me = await app.request("/api/auth/me", {
      headers: { Authorization: `Bearer ${signSessionToken(user.id)}` },
    });
    const body = await me.json();
    expect(body.user.avatarColor).toBeNull();
    expect(body.user.avatarLabel).toBeNull();
  });
});
