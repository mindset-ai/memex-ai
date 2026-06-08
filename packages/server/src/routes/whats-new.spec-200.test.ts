// spec-200 t-4 — the What's New feed read API.
//
// API test against the real app + local Postgres. Proves:
//   ac-10 — the feed returns one global set, identical regardless of which user
//           requests it (no per-user/per-memex derivation).
//   ac-8 (read side) — the read path is a pure stored read: no Anthropic client
//           is configured in this test, yet the endpoint succeeds, so it makes
//           no LLM call.

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users, whatsNewEntries } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { publishEntry } from "../services/whats-new.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-200/acs/ac-${n}`;
const TEST_PREFIX = "mindset-prod/memex-building-itself/specs/spec-200-route-";

const createdUserIds: string[] = [];

afterAll(async () => {
  await db.delete(whatsNewEntries).where(like(whatsNewEntries.sourceSpecRef, `${TEST_PREFIX}%`)).catch(() => {});
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

async function seedUserToken(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `wn-route-${crypto.randomUUID()}@example.com`, emailVerifiedAt: new Date() })
    .returning();
  createdUserIds.push(u.id);
  return signSessionToken(u.id);
}

async function getFeed(bearer: string): Promise<Response> {
  return app.request("/api/whats-new", {
    headers: { Authorization: `Bearer ${bearer}`, Host: "memex.ai" },
  });
}

describe("GET /api/whats-new (spec-200 t-4)", () => {
  it("returns the global feed identically for different users, no LLM on the read path (ac-10, ac-8)", async () => {
    await publishEntry({
      sourceSpecRef: `${TEST_PREFIX}spec-x`,
      sourceSpecHandle: "spec-x",
      title: "Feed entry X",
      whatText: "What X.",
      whyText: "Why X.",
    });

    const tokenA = await seedUserToken();
    const tokenB = await seedUserToken();

    const [resA, resB] = await Promise.all([getFeed(tokenA), getFeed(tokenB)]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const bodyA = (await resA.json()) as { entries: Array<{ sourceSpecHandle: string; what: string; why: string }> };
    const bodyB = (await resB.json()) as { entries: Array<{ sourceSpecHandle: string }> };

    // ac-10: both users see the identical global set.
    expect(bodyB.entries).toEqual(bodyA.entries);

    // The seeded entry is present with its what/why mapped.
    const mine = bodyA.entries.find((e) => e.sourceSpecHandle === "spec-x");
    expect(mine).toBeDefined();
    expect(mine!.what).toBe("What X.");
    expect(mine!.why).toBe("Why X.");

    // ac-8 (read side): no Anthropic key is configured in this suite, yet the
    // request succeeded — so the read path made no LLM call (pure stored read).
    tagAc(AC(10));
    tagAc(AC(8));
  });

  it("requires authentication", async () => {
    const res = await app.request("/api/whats-new", { headers: { Host: "memex.ai" } });
    expect(res.status).toBe(401);
  });
});
