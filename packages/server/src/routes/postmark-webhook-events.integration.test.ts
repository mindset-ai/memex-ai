import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { commsEvent, users } from "../db/schema.js";
import { recordComm } from "../services/comms-log.js";
import { postmarkWebhookRouter } from "./postmark-webhook.js";

// spec-12 t-2 — the webhook's comms_event enrichment.
//   ac-14: Open / Click / Bounce / SpamComplaint each persist a comms_event row;
//          bounce type & reason are captured.
//   ac-17: idempotent (dedup on source_ref+type+occurred_at); a late/duplicate
//          Delivery doesn't override a later Bounce (recency-resolvable); unknown
//          types are no-ops; the write is fire-and-forget (the response never waits).

const AC_EVENTS = "mindset-prod/memex-backstage/specs/spec-12/acs/ac-14";
const AC_IDEMPOTENT = "mindset-prod/memex-backstage/specs/spec-12/acs/ac-17";

const TOKEN = "test-pm-token-spec12";
const authHeader = { Authorization: `Basic ${Buffer.from(`postmark:${TOKEN}`).toString("base64")}` };

let userId: string;

beforeAll(async () => {
  process.env.POSTMARK_WEBHOOK_TOKEN = TOKEN;
  const [u] = await db
    .insert(users)
    .values({ email: "spec12-webhook-events@example.com" })
    .returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
  delete process.env.POSTMARK_WEBHOOK_TOKEN;
});

async function post(body: unknown, headers: Record<string, string> = authHeader) {
  return postmarkWebhookRouter.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Seed a comms_log row for `sourceRef` so the event has a parent to attach to. */
async function seedSend(sourceRef: string) {
  await recordComm({ userId, channel: "email", type: "transactional", status: "sent", sourceRef });
}

/** The webhook records comms_event fire-and-forget; poll until rows appear. */
async function eventsFor(sourceRef: string, expectAtLeast = 1, tries = 40): Promise<Array<typeof commsEvent.$inferSelect>> {
  for (let i = 0; i < tries; i++) {
    const rows = await db.select().from(commsEvent).where(eq(commsEvent.sourceRef, sourceRef));
    if (rows.length >= expectAtLeast) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return db.select().from(commsEvent).where(eq(commsEvent.sourceRef, sourceRef));
}

describe("spec-12 t-2: webhook persists comms_event rows (ac-14)", () => {
  it("ac-14: an Open event is persisted as a comms_event row", async () => {
    tagAc(AC_EVENTS);
    const ref = "pm12-open-1";
    await seedSend(ref);
    const res = await post({ RecordType: "Open", MessageID: ref, ReceivedAt: "2026-06-30T10:00:00Z" });
    expect(res.status).toBe(200);
    const rows = await eventsFor(ref);
    expect(rows.map((r) => r.eventType)).toContain("Open");
  });

  it("ac-14: a Click event is persisted", async () => {
    tagAc(AC_EVENTS);
    const ref = "pm12-click-1";
    await seedSend(ref);
    await post({ RecordType: "Click", MessageID: ref, ReceivedAt: "2026-06-30T10:05:00Z" });
    const rows = await eventsFor(ref);
    expect(rows.map((r) => r.eventType)).toContain("Click");
  });

  it("ac-14: a Bounce captures bounce type + reason", async () => {
    tagAc(AC_EVENTS);
    const ref = "pm12-bounce-1";
    await seedSend(ref);
    await post({
      RecordType: "Bounce",
      MessageID: ref,
      Type: "HardBounce",
      Description: "The server was unable to deliver your message (ex: unknown user)",
      BouncedAt: "2026-06-30T10:10:00Z",
    });
    const rows = await eventsFor(ref);
    const bounce = rows.find((r) => r.eventType === "Bounce");
    expect(bounce, "a Bounce comms_event row should exist").toBeTruthy();
    expect(bounce!.bounceType).toBe("HardBounce");
    expect(bounce!.bounceReason).toContain("unable to deliver");
  });

  it("ac-14: a SpamComplaint captures its type", async () => {
    tagAc(AC_EVENTS);
    const ref = "pm12-spam-1";
    await seedSend(ref);
    await post({ RecordType: "SpamComplaint", MessageID: ref, Type: "SpamComplaint", BouncedAt: "2026-06-30T10:12:00Z" });
    const rows = await eventsFor(ref);
    expect(rows.map((r) => r.eventType)).toContain("SpamComplaint");
  });
});

describe("spec-12 t-2: webhook enrichment is idempotent + recency-resolvable (ac-17)", () => {
  it("ac-17: a duplicate event (same source_ref+type+timestamp) inserts exactly once", async () => {
    tagAc(AC_IDEMPOTENT);
    const ref = "pm12-dup-1";
    await seedSend(ref);
    const evt = { RecordType: "Delivery", MessageID: ref, DeliveredAt: "2026-06-30T11:00:00Z" };
    await post(evt);
    await eventsFor(ref); // wait for the first
    await post(evt); // redelivery — must dedup
    // give the second a chance to (not) insert
    await new Promise((r) => setTimeout(r, 200));
    const rows = await db
      .select()
      .from(commsEvent)
      .where(and(eq(commsEvent.sourceRef, ref), eq(commsEvent.eventType, "Delivery")));
    expect(rows).toHaveLength(1);
  });

  it("ac-17: a late/duplicate Delivery does not override a later Bounce — both stored, recency picks Bounce", async () => {
    tagAc(AC_IDEMPOTENT);
    const ref = "pm12-reorder-1";
    await seedSend(ref);
    // Delivery happened EARLIER (T1) but its webhook arrives out of order, after the
    // Bounce (T2). Both must persist; the latest-by-occurred_at event is the Bounce.
    await post({ RecordType: "Bounce", MessageID: ref, Type: "HardBounce", Description: "blocked", BouncedAt: "2026-06-30T12:05:00Z" });
    await eventsFor(ref);
    await post({ RecordType: "Delivery", MessageID: ref, DeliveredAt: "2026-06-30T12:00:00Z" });
    const rows = await eventsFor(ref, 2);
    expect(rows.length, "both Delivery and Bounce should be stored").toBeGreaterThanOrEqual(2);
    const latest = [...rows].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
    expect(latest!.eventType, "recency resolution: the later Bounce wins over the late Delivery").toBe("Bounce");
  });

  it("ac-17: an unknown record type writes no comms_event row and is a 200 no-op", async () => {
    tagAc(AC_IDEMPOTENT);
    const ref = "pm12-unknown-1";
    await seedSend(ref);
    const res = await post({ RecordType: "SubscriptionChange", MessageID: ref, ChangedAt: "2026-06-30T13:00:00Z" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    const rows = await db.select().from(commsEvent).where(eq(commsEvent.sourceRef, ref));
    expect(rows).toHaveLength(0);
  });

  it("ac-17: an event for an unlogged MessageID is a graceful no-op (no row, no error, 200)", async () => {
    tagAc(AC_IDEMPOTENT);
    const ref = "pm12-orphan-never-logged";
    const res = await post({ RecordType: "Delivery", MessageID: ref, DeliveredAt: "2026-06-30T14:00:00Z" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    const rows = await db.select().from(commsEvent).where(eq(commsEvent.sourceRef, ref));
    expect(rows).toHaveLength(0);
  });
});
