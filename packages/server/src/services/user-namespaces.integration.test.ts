// Re-enabled in t-19 of doc-15. The original test used the legacy `accounts`
// table layout (subdomain on accounts, personal_account_id on users); the new
// schema splits namespaces + memexes + orgs. PERSONAL_ACCOUNT_NAME is gone —
// replaced by PERSONAL_MEMEX_NAME exported from user-namespaces.ts.

import { describe, it, expect, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, namespaces } from "../db/schema.js";
import { upsertUserByEmail, getUserById } from "./users.js";
import { ensureUserMemex, ensureUserNamespace, PERSONAL_MEMEX_NAME } from "./user-namespaces.js";

// spec-177 AC refs
const AC_1 = "mindset-prod/memex-building-itself/specs/spec-177/acs/ac-1"; // resend email does not error
const AC_2 = "mindset-prod/memex-building-itself/specs/spec-177/acs/ac-2"; // namespace created exactly once
const AC_4 = "mindset-prod/memex-building-itself/specs/spec-177/acs/ac-4"; // no unhandled PostgresError
const AC_5 = "mindset-prod/memex-building-itself/specs/spec-177/acs/ac-5"; // ON CONFLICT DO NOTHING

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
    tagAc(AC_2);
    const user = await upsertUserByEmail(uniqueEmail("personal"));
    createdUserIds.push(user.id);

    const memex = await ensureUserMemex(user.id);
    expect(memex.name).toBe(PERSONAL_MEMEX_NAME);
    expect(memex.slug).toBe("personal");

    const refreshed = await getUserById(user.id);
    expect(refreshed?.namespaceId).toBeTruthy();
  });

  it("is idempotent — second call returns the existing memex without error", async () => {
    tagAc(AC_1);
    tagAc(AC_2);
    tagAc(AC_4);
    const user = await upsertUserByEmail(uniqueEmail("idempotent"));
    createdUserIds.push(user.id);

    const first = await ensureUserMemex(user.id);
    const second = await ensureUserMemex(user.id);
    expect(second.id).toBe(first.id);
  });

  it("concurrent calls do not throw — ON CONFLICT DO NOTHING absorbs the race (ac-5)", async () => {
    tagAc(AC_1);
    tagAc(AC_4);
    tagAc(AC_5);
    // Two concurrent ensureUserNamespace calls with the same userId simulate the
    // email-resend race: both see namespaceId=null, derive the same slug, and race
    // to INSERT. The loser hits ON CONFLICT DO NOTHING and falls back to a SELECT.
    const user = await upsertUserByEmail(uniqueEmail("race"));
    createdUserIds.push(user.id);

    const [r1, r2] = await Promise.all([
      ensureUserNamespace(user.id),
      ensureUserNamespace(user.id),
    ]);

    expect(r1.namespace.id).toBe(r2.namespace.id);
    expect(r1.namespace.slug).toBe(r2.namespace.slug);
  });

  it("creates a user-kind namespace owned by the user", async () => {
    tagAc(AC_2);
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
