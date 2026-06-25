import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { commsLog, users } from "../db/schema.js";
import { recordComm, updateCommDeliveryStatus, markCommSent, pruneCommsLog } from "./comms-log.js";

// spec-6 (memex-backstage) t-3 + t-4 — comms_log lifecycle transitions.
//
// ac-8 (t-3): a delivery webhook flips status by source_ref (sent → delivered /
//             failed); an unmatched source_ref is a graceful no-op.
// ac-11 (t-4): a scheduled-ahead comm is written with scheduled_for set + sent_at
//              null and shows as scheduled UNTIL markCommSent flips it.

const AC_DELIVERY_STATUS = "mindset-prod/memex-backstage/specs/spec-6/acs/ac-8";
const AC_SCHEDULED = "mindset-prod/memex-backstage/specs/spec-6/acs/ac-11";
const AC_RETENTION = "mindset-prod/memex-backstage/specs/spec-6/acs/ac-15";

let userId: string;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ email: "comms-log-lifecycle-test@example.com" })
    .returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  // comms_log rows cascade on user delete.
  if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("spec-6 t-3: delivery-status update by source_ref (ac-8)", () => {
  it("ac-8: a delivery webhook flips the matching row sent → delivered", async () => {
    tagAc(AC_DELIVERY_STATUS);

    const sourceRef = "postmark:deliv-1";
    await recordComm({ userId, channel: "email", type: "transactional", status: "sent", sourceRef });

    const updated = await updateCommDeliveryStatus(sourceRef, "delivered");
    expect(updated, "exactly the matching row should update").toBe(1);

    const [row] = await db.select().from(commsLog).where(eq(commsLog.sourceRef, sourceRef));
    expect(row!.status).toBe("delivered");
  });

  it("ac-8: an unmatched source_ref is a graceful no-op (0 rows, no throw)", async () => {
    tagAc(AC_DELIVERY_STATUS);

    const updated = await updateCommDeliveryStatus("postmark:does-not-exist", "failed");
    expect(updated).toBe(0);
  });
});

describe("spec-6 t-4: scheduled comm shows as scheduled until sent (ac-11)", () => {
  it("ac-11: a scheduled-ahead comm is written scheduled_for set / sent_at null, then flips to sent", async () => {
    tagAc(AC_SCHEDULED);

    const sourceRef = "activation:day2";
    const scheduledFor = new Date("2099-01-01T09:00:00Z"); // safely in the future

    const scheduled = await recordComm({
      userId,
      channel: "email",
      type: "activation",
      status: "scheduled",
      scheduledFor,
      sourceRef,
    });

    // While scheduled: planned ahead, not yet sent (this is what the timeline /
    // schedule renders as an upcoming item).
    expect(scheduled!.status).toBe("scheduled");
    expect(scheduled!.scheduledFor?.toISOString()).toBe(scheduledFor.toISOString());
    expect(scheduled!.sentAt, "a scheduled comm has not been sent yet").toBeNull();

    // Now it actually goes out.
    const sent = await markCommSent(sourceRef);
    expect(sent, "markCommSent should flip the unsent scheduled row").not.toBeNull();
    expect(sent!.status).toBe("sent");
    expect(sent!.sentAt, "sent_at is stamped on dispatch").not.toBeNull();
    // scheduled_for is retained as the original plan time.
    expect(sent!.scheduledFor?.toISOString()).toBe(scheduledFor.toISOString());
  });
});

describe("spec-6 t-8: retention prune (ac-15)", () => {
  it("ac-15: rows older than the window are pruned; recent rows are kept", async () => {
    tagAc(AC_RETENTION);

    const DAY = 86_400_000;
    const [oldRow] = await db
      .insert(commsLog)
      .values({
        userId,
        channel: "email",
        type: "transactional",
        status: "sent",
        sentAt: new Date(Date.now() - 100 * DAY),
        subject: "Old receipt",
        createdAt: new Date(Date.now() - 100 * DAY),
      })
      .returning({ id: commsLog.id });
    const [recentRow] = await db
      .insert(commsLog)
      .values({
        userId,
        channel: "email",
        type: "transactional",
        status: "sent",
        subject: "Recent receipt",
        createdAt: new Date(Date.now() - 5 * DAY),
      })
      .returning({ id: commsLog.id });

    const pruned = await pruneCommsLog(90);
    expect(pruned, "at least the 100-day-old row should be pruned").toBeGreaterThanOrEqual(1);

    const oldStill = await db.select().from(commsLog).where(eq(commsLog.id, oldRow!.id));
    expect(oldStill, "the 100-day-old row is gone").toHaveLength(0);

    const recentStill = await db.select().from(commsLog).where(eq(commsLog.id, recentRow!.id));
    expect(recentStill, "the 5-day-old row is retained").toHaveLength(1);
  });

  it("ac-15: the window is configurable (a tighter window prunes more)", async () => {
    tagAc(AC_RETENTION);

    const DAY = 86_400_000;
    const [row] = await db
      .insert(commsLog)
      .values({
        userId,
        channel: "in_app",
        type: "work_notification",
        status: "sent",
        subject: "Ten days old",
        createdAt: new Date(Date.now() - 10 * DAY),
      })
      .returning({ id: commsLog.id });

    // A 7-day window prunes the 10-day-old row that a 90-day window would keep.
    const pruned = await pruneCommsLog(7);
    expect(pruned).toBeGreaterThanOrEqual(1);
    const still = await db.select().from(commsLog).where(eq(commsLog.id, row!.id));
    expect(still).toHaveLength(0);
  });
});
