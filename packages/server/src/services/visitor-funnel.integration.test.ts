// Funnel-query sanity (spec-254 t-5, ac-6 / ac-2) — REAL Postgres.
//
// Proves the plumbing makes the primordial funnel COMPUTABLE: usage_events carry a
// visitor_id (ac-2), and COUNT(DISTINCT visitor_id) per step is queryable across
// the pre-auth (user_id NULL) → post-auth (user_id set) boundary, with the identify
// merge stitching a visitor's anonymous head to its identified tail via the visitors
// table (ac-6). Live capture of the anonymous pre-auth steps is the spec-244
// retrofit; here we seed the rows the retrofit will produce and prove the query.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { randomUUID } from "node:crypto";
import { and, count, countDistinct, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { usageEvents, visitors } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { recordUsageEvent } from "./usage-events.js";
import { mergeVisitor } from "./visitors.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-254/acs";

let memexId: string;
let userA: string;
const V1 = randomUUID(); // converts (signs up)
const V2 = randomUUID(); // drops off after email
const visitorIds = [V1, V2];

// The ordered funnel steps we seed.
const STEP = {
  firstSeen: "visitor.first_seen",
  email: "auth.email_submitted",
  signup: "auth.signup_completed",
} as const;

beforeAll(async () => {
  memexId = await makeTestMemex("vfunnel");
  userA = (await upsertUserByEmail(`vfunnel-a-${Date.now()}@memex.ai`)).id;

  // V1: full journey through signup. Pre-auth steps carry visitor_id, no user.
  await recordUsageEvent({ memexId, visitorId: V1, name: STEP.firstSeen, source: "frontend" });
  await recordUsageEvent({ memexId, visitorId: V1, name: STEP.email, source: "frontend" });
  // …then signs up: the identify merge binds V1 → userA.
  await mergeVisitor(V1, userA);
  await recordUsageEvent({
    memexId,
    visitorId: V1,
    actorUserId: userA,
    name: STEP.signup,
    source: "backend",
  });

  // V2: drops off after submitting an email — never signs up.
  await recordUsageEvent({ memexId, visitorId: V2, name: STEP.firstSeen, source: "frontend" });
  await recordUsageEvent({ memexId, visitorId: V2, name: STEP.email, source: "frontend" });
});

afterAll(async () => {
  await db.delete(usageEvents).where(eq(usageEvents.memexId, memexId)).catch(() => {});
  await db.delete(visitors).where(inArray(visitors.visitorId, visitorIds)).catch(() => {});
});

async function stepCount(name: string): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(usageEvents.visitorId) })
    .from(usageEvents)
    .where(and(eq(usageEvents.memexId, memexId), eq(usageEvents.name, name)));
  return Number(row.n);
}

describe("usage_events carry the visitor_id join key (ac-2)", () => {
  it("persists visitor_id on both pre-auth (user null) and post-auth (user set) rows", async () => {
    tagAc(`${AC}/ac-2`);
    const preAuth = await db
      .select({ n: count() })
      .from(usageEvents)
      .where(and(eq(usageEvents.memexId, memexId), isNull(usageEvents.actorUserId), isNotNull(usageEvents.visitorId)));
    const postAuth = await db
      .select({ n: count() })
      .from(usageEvents)
      .where(and(eq(usageEvents.memexId, memexId), isNotNull(usageEvents.actorUserId), isNotNull(usageEvents.visitorId)));
    expect(Number(preAuth[0].n)).toBeGreaterThanOrEqual(4); // V1+V2 first_seen+email
    expect(Number(postAuth[0].n)).toBeGreaterThanOrEqual(1); // V1 signup
  });
});

describe("the primordial funnel is computable as distinct visitor_id per step (ac-6)", () => {
  it("counts distinct visitors per step, including the pre-auth steps, and shows drop-off", async () => {
    tagAc(`${AC}/ac-6`);
    const firstSeen = await stepCount(STEP.firstSeen);
    const email = await stepCount(STEP.email);
    const signup = await stepCount(STEP.signup);

    expect(firstSeen).toBe(2); // V1, V2
    expect(email).toBe(2); // V1, V2
    expect(signup).toBe(1); // only V1 converted — V2 dropped off
    // The funnel narrows: a real, computable top-of-funnel drop-off.
    expect(signup).toBeLessThan(firstSeen);
  });

  it("stitches a visitor's anonymous head to its identified tail via the merge (ac-6)", async () => {
    tagAc(`${AC}/ac-6`);
    // V1's binding resolves to userA, so its pre-auth rows are joinable to the user.
    const [bound] = await db.select().from(visitors).where(eq(visitors.visitorId, V1));
    expect(bound.userId).toBe(userA);

    // Join: all of V1's events (pre- AND post-auth) attribute to userA via visitors.
    const joined = await db
      .select({ n: count() })
      .from(usageEvents)
      .innerJoin(visitors, eq(usageEvents.visitorId, visitors.visitorId))
      .where(and(eq(usageEvents.memexId, memexId), eq(visitors.userId, userA)));
    expect(Number(joined[0].n)).toBe(3); // first_seen + email + signup, all stitched to userA
  });
});
