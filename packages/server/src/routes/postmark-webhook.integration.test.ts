import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { commsLog, users } from "../db/schema.js";
import { recordComm } from "../services/comms-log.js";
import { postmarkWebhookRouter } from "./postmark-webhook.js";

// spec-341 t-2 — the Postmark delivery webhook. ac-3/ac-7: a Delivery/Bounce event
// updates the matching comms_log row's status by MessageID. ac-9: unknown MessageID
// is a graceful no-op; the match is source-agnostic. Plus the Basic-auth gate.

const AC_WEBHOOK = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-3";
const AC_WEBHOOK_IMPL = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-7";
const AC_SOURCE_AGNOSTIC = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-9";

const TOKEN = "test-pm-token";
const authHeader = { Authorization: `Basic ${Buffer.from(`postmark:${TOKEN}`).toString("base64")}` };

let userId: string;

beforeAll(async () => {
  process.env.POSTMARK_WEBHOOK_TOKEN = TOKEN;
  const [u] = await db.insert(users).values({ email: "postmark-webhook-test@example.com" }).returning({ id: users.id });
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

describe("spec-341 t-2: Postmark delivery webhook (ac-3/7/9)", () => {
  it("ac-3/ac-7: a Delivery event flips the matching row sent → delivered by MessageID", async () => {
    tagAc(AC_WEBHOOK);
    tagAc(AC_WEBHOOK_IMPL);
    const sourceRef = "pm-deliv-1";
    await recordComm({ userId, channel: "email", type: "transactional", status: "sent", sourceRef });

    const res = await post({ RecordType: "Delivery", MessageID: sourceRef });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(commsLog).where(eq(commsLog.sourceRef, sourceRef));
    expect(row!.status).toBe("delivered");
  });

  it("ac-7: a Bounce event flips the matching row → failed", async () => {
    tagAc(AC_WEBHOOK_IMPL);
    const sourceRef = "pm-bounce-1";
    await recordComm({ userId, channel: "email", type: "transactional", status: "sent", sourceRef });

    await post({ RecordType: "Bounce", MessageID: sourceRef });
    const [row] = await db.select().from(commsLog).where(eq(commsLog.sourceRef, sourceRef));
    expect(row!.status).toBe("failed");
  });

  it("ac-9: an unknown MessageID is a graceful no-op (200, applied:false)", async () => {
    tagAc(AC_SOURCE_AGNOSTIC);
    const res = await post({ RecordType: "Delivery", MessageID: "pm-does-not-exist" });
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(false);
  });

  it("ac-9: an engagement event (Open) is accepted without changing status", async () => {
    tagAc(AC_SOURCE_AGNOSTIC);
    const sourceRef = "pm-open-1";
    await recordComm({ userId, channel: "email", type: "transactional", status: "sent", sourceRef });
    await post({ RecordType: "Open", MessageID: sourceRef });
    const [row] = await db.select().from(commsLog).where(eq(commsLog.sourceRef, sourceRef));
    expect(row!.status).toBe("sent"); // unchanged
  });

  it("ac-7: rejects a request with a missing/wrong Basic credential (401)", async () => {
    tagAc(AC_WEBHOOK_IMPL);
    const noAuth = await post({ RecordType: "Delivery", MessageID: "x" }, {});
    expect(noAuth.status).toBe(401);
    const wrong = await post({ RecordType: "Delivery", MessageID: "x" }, {
      Authorization: `Basic ${Buffer.from("postmark:wrong").toString("base64")}`,
    });
    expect(wrong.status).toBe(401);
  });
});
