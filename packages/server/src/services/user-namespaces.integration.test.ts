// Re-enabled in t-19 of doc-15. The original test used the legacy `accounts`
// table layout (subdomain on accounts, personal_account_id on users); the new
// schema splits namespaces + memexes + orgs. PERSONAL_ACCOUNT_NAME is gone —
// replaced by PERSONAL_MEMEX_NAME exported from user-namespaces.ts.

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, namespaces } from "../db/schema.js";
import { upsertUserByEmail, getUserById } from "./users.js";
import { ensureUserMemex, ensureUserNamespace, PERSONAL_MEMEX_NAME } from "./user-namespaces.js";

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe("ensureUserMemex / ensureUserNamespace", () => {
  it("creates a personal namespace + memex on first call", async () => {
    const user = await upsertUserByEmail(uniqueEmail("personal"));
    createdUserIds.push(user.id);

    const memex = await ensureUserMemex(user.id);
    expect(memex.name).toBe(PERSONAL_MEMEX_NAME);
    expect(memex.slug).toBe("personal");

    const refreshed = await getUserById(user.id);
    expect(refreshed?.namespaceId).toBeTruthy();
  });

  it("is idempotent — second call returns the existing memex", async () => {
    const user = await upsertUserByEmail(uniqueEmail("idempotent"));
    createdUserIds.push(user.id);

    const first = await ensureUserMemex(user.id);
    const second = await ensureUserMemex(user.id);
    expect(second.id).toBe(first.id);
  });

  it("creates a user-kind namespace owned by the user", async () => {
    const user = await upsertUserByEmail(uniqueEmail("nsowner"));
    createdUserIds.push(user.id);

    const { namespace } = await ensureUserNamespace(user.id);
    expect(namespace.kind).toBe("user");
    expect(namespace.ownerUserId).toBe(user.id);

    // The namespace.slug is derived from the email local-part.
    const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, namespace.id) });
    expect(ns?.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});
