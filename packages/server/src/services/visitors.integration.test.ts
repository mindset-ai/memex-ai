// Integration tests for the visitors store (spec-254 t-1) — REAL Postgres.
//
// The identity boundary is tested against a real DB (no mocks): real users (so the
// FK resolves), then we record visitors and exercise the merge, asserting the
// bind-once invariant (spec-254 dec-3) holds at the row level.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { visitors } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import { recordVisitor, mergeVisitor } from "./visitors.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-254/acs";

let userA: string;
let userB: string;
const minted: string[] = [];

function vid(): string {
  const id = randomUUID();
  minted.push(id);
  return id;
}

beforeAll(async () => {
  const a = await upsertUserByEmail(`visitor-a-${Date.now()}@memex.ai`);
  const b = await upsertUserByEmail(`visitor-b-${Date.now()}@memex.ai`);
  userA = a.id;
  userB = b.id;
});

afterAll(async () => {
  if (minted.length) await db.delete(visitors).where(inArray(visitors.visitorId, minted));
});

describe("recordVisitor — first-sight persistence (ac-9)", () => {
  it("persists a visitors row with user_id null until identified", async () => {
    tagAc(`${AC}/ac-9`);
    const id = vid();
    const row = await recordVisitor(id);
    expect(row).not.toBeNull();
    expect(row?.visitorId).toBe(id);
    expect(row?.userId).toBeNull();
    expect(row?.mergedAt).toBeNull();
    expect(row?.firstSeenAt).toBeInstanceOf(Date);
  });

  it("is idempotent — a second sighting keeps the original first_seen_at", async () => {
    tagAc(`${AC}/ac-9`);
    const id = vid();
    const first = await recordVisitor(id);
    const second = await recordVisitor(id);
    expect(second?.firstSeenAt?.getTime()).toBe(first?.firstSeenAt?.getTime());
  });
});

describe("mergeVisitor — the identify step + bind-once invariant (ac-10, ac-11)", () => {
  it("stamps user_id + merged_at on an unbound visitor (ac-10)", async () => {
    tagAc(`${AC}/ac-10`);
    const id = vid();
    await recordVisitor(id);
    const outcome = await mergeVisitor(id, userA);
    expect(outcome?.status).toBe("merged");
    const [row] = await db.select().from(visitors).where(eq(visitors.visitorId, id));
    expect(row.userId).toBe(userA);
    expect(row.mergedAt).toBeInstanceOf(Date);
  });

  it("re-identifying the SAME user is an idempotent no-op (ac-10)", async () => {
    tagAc(`${AC}/ac-10`);
    const id = vid();
    await mergeVisitor(id, userA);
    const again = await mergeVisitor(id, userA);
    expect(again?.status).toBe("already");
    const [row] = await db.select().from(visitors).where(eq(visitors.visitorId, id));
    expect(row.userId).toBe(userA);
  });

  it("a DIFFERENT user does NOT overwrite the binding — caller mints fresh (ac-11)", async () => {
    tagAc(`${AC}/ac-11`);
    const id = vid();
    await mergeVisitor(id, userA);
    const outcome = await mergeVisitor(id, userB);
    expect(outcome?.status).toBe("rebind");
    const [row] = await db.select().from(visitors).where(eq(visitors.visitorId, id));
    expect(row.userId).toBe(userA); // unchanged — bind-once invariant holds
  });

  it("merges even with no prior recordVisitor (the auth POST is first sight) (ac-10)", async () => {
    tagAc(`${AC}/ac-10`);
    const id = vid();
    const outcome = await mergeVisitor(id, userA);
    expect(outcome?.status).toBe("merged");
    const [row] = await db.select().from(visitors).where(eq(visitors.visitorId, id));
    expect(row.userId).toBe(userA);
  });
});
