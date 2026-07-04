// spec-453 t-6 (dec-11) — the shared lifecycle tick against a real DB: hitting the
// endpoint twice sends the "Connect with people" email exactly ONCE (idempotent across
// invocations), because the pass dedups on the stable comms_log key. This is the property
// that makes Cloud Scheduler retries — and any duplicate fire — safe.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { users, commsLog } from "../db/schema.js";
import { setEmailSender, type EmailMessage } from "../services/email/sender.js";
import { recordEmailComm } from "../services/comms-log.js";
import { internalLifecycleRouter } from "./internal-lifecycle.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-453/acs/ac-${n}`;

const app = new Hono();
app.route("/api/internal", internalLifecycleRouter);

const SECRET = "s3cret-scheduler-token";
const DAY = 24 * 60 * 60 * 1000;
const created: string[] = [];
let sent: EmailMessage[];
const savedEnv = { ...process.env };

function tick() {
  return app.request("/api/internal/lifecycle-tick", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

async function seedConnectEligibleUser(email: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email,
      emailVerifiedAt: new Date(),
      // 20 days old → past the Day-12 offset. Real "now" is used by the endpoint.
      createdAt: new Date(Date.now() - 20 * DAY),
    })
    .returning({ id: users.id });
  created.push(u!.id);
  return u!.id;
}

beforeEach(() => {
  sent = [];
  // A faithful stand-in for PostmarkEmailSender: it ALSO records the comms_log row
  // (recordEmailComm, exactly as the real sender does), so the pass's hasComm dedup can
  // see the prior send on the second tick — which is the whole point of this test.
  setEmailSender({
    send: async (m) => {
      sent.push(m);
      await recordEmailComm({ to: m.to, userId: m.userId, commsType: m.commsType, subject: m.subject });
    },
  });
  process.env.LIFECYCLE_TICK_SECRET = SECRET;
  process.env.ACTIVATION_EMAILS_ENABLED = "1";
  // A fixed go-live well before the seeded user's Day-12 crossing, so they qualify and
  // are not treated as back-catalog.
  process.env.ACTIVATION_CONNECT_GO_LIVE = "2026-01-01T00:00:00Z";
  process.env.EMAIL_ACTIVATION_FROM = "The Memex AI team <support@memex.ai>";
  process.env.EMAIL_ACTIVATION_REPLY_TO = "support@memex.ai";
});
afterEach(async () => {
  setEmailSender(null);
  process.env = { ...savedEnv };
  if (created.length) {
    await db.delete(commsLog).where(inArray(commsLog.userId, created)).catch(() => {});
    await db.delete(users).where(inArray(users.id, created)).catch(() => {});
    created.length = 0;
  }
});

describe("POST /api/internal/lifecycle-tick — idempotent across invocations (ac-20)", () => {
  it("two ticks send the 'Connect with people' email exactly once (dedup on the stable comms key)", async () => {
    tagAc(AC(20));
    await seedConnectEligibleUser("tick-connect@example.test");

    const r1 = await tick();
    const r2 = await tick();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const connectSends = sent.filter((m) => m.commsType === "activation.connect_people");
    expect(connectSends).toHaveLength(1);
  });
});
