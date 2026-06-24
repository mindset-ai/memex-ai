// spec-341 t-2: Postmark delivery webhook.
//
// Mounted at /api/postmark/webhook (flat, no tenancy prefix — Postmark calls this
// directly). NO sessionMiddleware — like the Stripe webhook (routes/stripe-webhook.ts),
// the webhook's own auth IS the auth. Postmark authenticates via HTTP Basic on the
// webhook URL (you configure user:token in the Postmark server's webhook settings),
// so we verify the Basic credential against POSTMARK_WEBHOOK_TOKEN before processing.
//
// Postmark posts one JSON object per event with a RecordType + MessageID. We map the
// delivery-outcome types to a comms_log status and update the row by MessageID
// (source_ref). Open/Click/etc. are 200 no-ops. Matching is source-agnostic — any
// Postmark-sent email is updated regardless of which code path sent it (spec-341 ac-9).
import { Hono } from "hono";
import { updateCommDeliveryStatus } from "../services/comms-log.js";

const postmarkWebhookRouter = new Hono();

/** Decode an `Authorization: Basic base64(user:pass)` header → its password part. */
function basicAuthPassword(header: string | undefined): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    return idx === -1 ? decoded : decoded.slice(idx + 1);
  } catch {
    return null;
  }
}

// Postmark RecordType → comms_log status. Only delivery outcomes update a row;
// engagement types (Open, Click, SubscriptionChange) are ignored.
const STATUS_BY_RECORD_TYPE: Record<string, "delivered" | "failed"> = {
  Delivery: "delivered",
  Bounce: "failed",
  SpamComplaint: "failed",
};

postmarkWebhookRouter.post("/", async (c) => {
  const expected = process.env.POSTMARK_WEBHOOK_TOKEN;
  const supplied = basicAuthPassword(c.req.header("authorization"));
  // No configured token, or a mismatch ⇒ reject. The Basic credential is the auth.
  if (!expected || supplied !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let payload: { RecordType?: unknown; MessageID?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Expected a JSON body" }, 400);
  }

  const recordType = typeof payload.RecordType === "string" ? payload.RecordType : "";
  const messageId = typeof payload.MessageID === "string" ? payload.MessageID : "";
  const status = STATUS_BY_RECORD_TYPE[recordType];

  // Not a delivery-outcome event (Open/Click/etc.), or no MessageID → accept + no-op.
  if (!status || !messageId) {
    return c.json({ received: true, applied: false });
  }

  // Advisory: updateCommDeliveryStatus is a no-op for an unknown MessageID and
  // swallows its own errors. Always answer 200 so Postmark stops retrying.
  const updated = await updateCommDeliveryStatus(messageId, status);
  return c.json({ received: true, applied: updated > 0 });
});

export { postmarkWebhookRouter };
