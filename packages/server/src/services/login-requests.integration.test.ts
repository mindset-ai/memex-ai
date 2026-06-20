// spec-304: the login_requests surrogate service against a live DB. Mirrors the posture of
// auth-tokens.integration.test.ts — real inserts/updates/deletes, cleaned up via the user
// CASCADE chain (login_requests → auth_tokens → users).

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import { issueAuthToken } from "./auth-tokens.js";
import {
  createLoginRequest,
  getLoginRequestStatus,
  markLoginRequestVerified,
  deleteLoginRequest,
} from "./login-requests.js";

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    // CASCADE: users → auth_tokens → login_requests.
    await db
      .delete(users)
      .where(inArray(users.id, createdUserIds))
      .catch(() => {});
  }
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function seedTokenAndRequest(prefix: string) {
  const user = await upsertUserByEmail(uniqueEmail(prefix));
  createdUserIds.push(user.id);
  const issued = await issueAuthToken({ purpose: "magic_link", email: user.email, userId: user.id });
  const created = await createLoginRequest({
    tokenId: issued.row.id,
    email: user.email,
    expiresAt: issued.row.expiresAt,
  });
  return { user, tokenId: issued.row.id, loginRequestId: created.id };
}

describe("login-requests service", () => {
  it("creates a pollable surrogate that starts unverified", async () => {
    const { loginRequestId, tokenId, user } = await seedTokenAndRequest("create");

    const row = await getLoginRequestStatus(loginRequestId);
    expect(row).not.toBeNull();
    expect(row!.tokenId).toBe(tokenId);
    expect(row!.email).toBe(user.email);
    expect(row!.verifiedAt).toBeNull();
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null for an unknown id", async () => {
    expect(await getLoginRequestStatus("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await getLoginRequestStatus("")).toBeNull();
  });

  it("returns null (not a thrown uuid-cast error) for a malformed id", async () => {
    // Regression: the status route is unauthenticated, so a non-uuid :id must resolve to a
    // clean 404 — never an uncaught Postgres "invalid input syntax for type uuid" → 500.
    expect(await getLoginRequestStatus("not-a-uuid")).toBeNull();
    expect(await getLoginRequestStatus("12345")).toBeNull();
    expect(await getLoginRequestStatus("'; DROP TABLE login_requests;--")).toBeNull();
  });

  it("markLoginRequestVerified stamps the row whose tokenId matches", async () => {
    const { loginRequestId, tokenId } = await seedTokenAndRequest("verify");

    const updated = await markLoginRequestVerified(tokenId);
    expect(updated).not.toBeNull();

    const row = await getLoginRequestStatus(loginRequestId);
    expect(row!.verifiedAt).not.toBeNull();
  });

  it("deleteLoginRequest single-shots the surrogate", async () => {
    const { loginRequestId } = await seedTokenAndRequest("delete");

    const deleted = await deleteLoginRequest(loginRequestId);
    expect(deleted).not.toBeNull();
    expect(await getLoginRequestStatus(loginRequestId)).toBeNull();
    // Second delete is a no-op (idempotent under double-poll).
    expect(await deleteLoginRequest(loginRequestId)).toBeNull();
  });

  it("cascades away when the auth token is deleted", async () => {
    const { loginRequestId, tokenId } = await seedTokenAndRequest("cascade");
    const { authTokens } = await import("../db/schema.js");
    await db.delete(authTokens).where(eq(authTokens.id, tokenId));
    expect(await getLoginRequestStatus(loginRequestId)).toBeNull();
  });
});
