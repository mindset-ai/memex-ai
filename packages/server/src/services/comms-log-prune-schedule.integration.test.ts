import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { commsLog, users } from "../db/schema.js";
import { startCommsLogPrune } from "./comms-log.js";

// spec-341 t-3 (ac-8) — the scheduled prune actually runs pruneCommsLog on its
// interval. Mirrors startActivityLogSweep; index.ts boots it daily + .unref()'d.
// Here we drive a tiny interval and confirm an over-retention row is pruned.

const AC8 = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-8";
const AC4 = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-4"; // scope: pruned automatically on a schedule
const DAY = 86_400_000;

let userId: string;

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: "comms-prune-sched@example.com" }).returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("spec-341 t-3: startCommsLogPrune (ac-8)", () => {
  it("ac-8: the scheduled job invokes pruneCommsLog on its interval", async () => {
    tagAc(AC8);
    tagAc(AC4);

    const [old] = await db
      .insert(commsLog)
      .values({
        userId,
        channel: "email",
        type: "transactional",
        status: "sent",
        // spec-442: a 'sent' row must carry a send time (comms_log_sent_requires_sent_at).
        sentAt: new Date(Date.now() - 101 * DAY),
        createdAt: new Date(Date.now() - 101 * DAY),
      })
      .returning({ id: commsLog.id });

    const timer = startCommsLogPrune(20); // 20ms interval for the test
    try {
      await new Promise((r) => setTimeout(r, 150)); // allow a few ticks to fire
      const still = await db.select().from(commsLog).where(eq(commsLog.id, old!.id));
      expect(still, "the scheduled prune deleted the over-retention row").toHaveLength(0);
    } finally {
      clearInterval(timer);
    }
  });
});
