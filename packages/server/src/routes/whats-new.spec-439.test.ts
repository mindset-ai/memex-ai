// spec-439 — server-side suppressBefore field in GET /api/whats-new.
//
// ac-5  GET /api/whats-new returns suppressBefore = requesting user's createdAt ISO string
// ac-6  Route handler reads user.createdAt from auth context and serialises it as suppressBefore

import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-439/acs/ac-${n}`;

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

describe("GET /api/whats-new suppressBefore (spec-439)", () => {
  it("returns suppressBefore equal to the requesting user's createdAt ISO string (ac-5, ac-6)", async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `wn-suppress-${crypto.randomUUID()}@example.com`, emailVerifiedAt: new Date() })
      .returning();
    createdUserIds.push(u.id);

    const bearer = signSessionToken(u.id);
    const res = await app.request("/api/whats-new", {
      headers: { Authorization: `Bearer ${bearer}`, Host: "memex.ai" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { suppressBefore: string; entries: unknown[] };

    // ac-5: suppressBefore is present in the response
    expect(typeof body.suppressBefore).toBe("string");

    // ac-6: suppressBefore equals the user's createdAt as an ISO string
    expect(body.suppressBefore).toBe(u.createdAt.toISOString());

    tagAc(AC(5));
    tagAc(AC(6));
  });
});
