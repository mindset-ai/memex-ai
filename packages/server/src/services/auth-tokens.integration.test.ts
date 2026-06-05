import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { authTokens, users } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import {
  issueAuthToken,
  consumeAuthToken,
  AuthTokenError,
} from "./auth-tokens.js";

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    // ON DELETE CASCADE on auth_tokens removes dependent rows automatically.
    await db
      .delete(users)
      .where(inArray(users.id, createdUserIds))
      .catch(() => {});
  }
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe("auth-tokens", () => {
  it("issues a token that can be consumed exactly once", async () => {
    const user = await upsertUserByEmail(uniqueEmail("once"));
    createdUserIds.push(user.id);

    const issued = await issueAuthToken({
      purpose: "email_verification",
      email: user.email,
      userId: user.id,
    });

    const consumed = await consumeAuthToken("email_verification", issued.raw);
    expect(consumed.userId).toBe(user.id);
    expect(consumed.email).toBe(user.email);

    // Second attempt fails.
    await expect(
      consumeAuthToken("email_verification", issued.raw)
    ).rejects.toMatchObject({ reason: "consumed" });
  });

  it("stores the sha256 hash — the raw token is NOT persisted", async () => {
    const user = await upsertUserByEmail(uniqueEmail("hash"));
    createdUserIds.push(user.id);

    const issued = await issueAuthToken({
      purpose: "magic_link",
      email: user.email,
      userId: user.id,
    });

    // Look up the row and verify the DB column doesn't contain the raw string.
    const rows = await db
      .select()
      .from(authTokens)
      .where(eq(authTokens.id, issued.row.id));
    expect(rows[0].tokenHash).not.toBe(issued.raw);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects tokens for the wrong purpose", async () => {
    const user = await upsertUserByEmail(uniqueEmail("wrong"));
    createdUserIds.push(user.id);

    const issued = await issueAuthToken({
      purpose: "email_verification",
      email: user.email,
      userId: user.id,
    });

    await expect(
      consumeAuthToken("magic_link", issued.raw)
    ).rejects.toMatchObject({ reason: "wrong_purpose" });
  });

  it("rejects expired tokens", async () => {
    const user = await upsertUserByEmail(uniqueEmail("exp"));
    createdUserIds.push(user.id);

    const issued = await issueAuthToken({
      purpose: "magic_link",
      email: user.email,
      userId: user.id,
    });
    // Force-expire the row.
    await db
      .update(authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authTokens.id, issued.row.id));

    await expect(
      consumeAuthToken("magic_link", issued.raw)
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("rejects unknown/empty tokens", async () => {
    await expect(consumeAuthToken("email_verification", "")).rejects.toThrow(
      AuthTokenError,
    );
    await expect(
      consumeAuthToken("email_verification", "garbage-not-in-db")
    ).rejects.toMatchObject({ reason: "unknown" });
  });

  it("supports userId=null (magic-link signup path where no user exists yet)", async () => {
    const email = uniqueEmail("newuser");
    const issued = await issueAuthToken({
      purpose: "magic_link",
      email,
      userId: null,
    });
    const consumed = await consumeAuthToken("magic_link", issued.raw);
    expect(consumed.userId).toBeNull();
    expect(consumed.email).toBe(email);
  });
});
