// spec-341 t-2 / spec-12 t-2: Postmark delivery + engagement webhook.
//
// Mounted at /api/postmark/webhook (flat, no tenancy prefix — Postmark calls this
// directly). NO sessionMiddleware — like the Stripe webhook (routes/stripe-webhook.ts),
// the webhook's own auth IS the auth. Postmark authenticates via HTTP Basic on the
// webhook URL (you configure user:token in the Postmark server's webhook settings),
// so we verify the Basic credential against POSTMARK_WEBHOOK_TOKEN before processing.
//
// Postmark posts one JSON object per event with a RecordType + MessageID. Two things
// happen per event, both keyed on MessageID (= comms_log.source_ref), both advisory:
//   1. STATUS FLIP (spec-341): delivery-outcome types flip the comms_log row's status
//      (Delivery→delivered, Bounce/SpamComplaint→failed). Engagement types (Open,
//      Click) and unknown types do NOT change status — they stay a 200 no-op here.
//   2. EVENT ENRICHMENT (spec-12 dec-2): Delivery / Open / Click / Bounce /
//      SpamComplaint are each written as a comms_event row (one row per event) so the
//      Comms page can resolve a true per-message OUTCOME, show the engagement trail,
//      and detect repeats — fidelity the thin status shadow can't carry. The write is
//      fire-and-forget + idempotent (dedup on source_ref+type+timestamp), so a
//      redelivered event or a webhook fault never blocks or corrupts core's send path.
// Matching is source-agnostic — any Postmark-sent email is updated regardless of
// which code path sent it (spec-341 ac-9).
import { Hono } from "hono";
import { recordCommEvent, updateCommDeliveryStatus } from "../services/comms-log.js";

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
// engagement types (Open, Click, SubscriptionChange) leave status as-is.
const STATUS_BY_RECORD_TYPE: Record<string, "delivered" | "failed"> = {
  Delivery: "delivered",
  Bounce: "failed",
  SpamComplaint: "failed",
};

// RecordTypes we persist as comms_event rows (spec-12). A superset of the status
// types — it adds the engagement types Open + Click. Anything else stays a no-op.
const EVENT_RECORD_TYPES = new Set(["Delivery", "Open", "Click", "Bounce", "SpamComplaint"]);

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Extract the Postmark EVENT timestamp for dedup/recency. The field name varies by
 * RecordType: Delivery→DeliveredAt, Bounce/SpamComplaint→BouncedAt, Open/Click→
 * ReceivedAt. Returns a valid Date or null (a missing/unparseable timestamp means we
 * can't dedup, so the event is skipped rather than recorded with a wrong time).
 */
function eventTimestamp(payload: Record<string, unknown>): Date | null {
  const raw =
    asString(payload.DeliveredAt) ??
    asString(payload.BouncedAt) ??
    asString(payload.ReceivedAt);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

postmarkWebhookRouter.post("/", async (c) => {
  const expected = process.env.POSTMARK_WEBHOOK_TOKEN;
  const supplied = basicAuthPassword(c.req.header("authorization"));
  // No configured token, or a mismatch ⇒ reject. The Basic credential is the auth.
  if (!expected || supplied !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Expected a JSON body" }, 400);
  }

  const recordType = asString(payload.RecordType) ?? "";
  const messageId = asString(payload.MessageID) ?? "";

  // No MessageID → nothing to match on. Accept + no-op (Postmark stops retrying).
  if (!messageId) {
    return c.json({ received: true, applied: false });
  }

  // 2) Enrichment: write a comms_event row for the types we track. Fire-and-forget
  //    + advisory (recordCommEvent resolves the parent by source_ref, dedups, and
  //    swallows its own errors), so it never blocks or fails the response. Bounce
  //    type/reason are captured for Bounce/SpamComplaint; Open/Click carry neither.
  if (EVENT_RECORD_TYPES.has(recordType)) {
    const occurredAt = eventTimestamp(payload);
    if (occurredAt) {
      const isBounce = recordType === "Bounce" || recordType === "SpamComplaint";
      void recordCommEvent({
        sourceRef: messageId,
        eventType: recordType,
        occurredAt,
        bounceType: isBounce ? asString(payload.Type) ?? null : null,
        bounceReason: isBounce
          ? asString(payload.Description) ?? asString(payload.Details) ?? null
          : null,
      });
    }
  }

  // 1) Status flip: only delivery-outcome types touch comms_log.status. Advisory:
  //    updateCommDeliveryStatus is a no-op for an unknown MessageID and swallows its
  //    own errors. `applied` reflects this status flip (unchanged spec-341 contract).
  const status = STATUS_BY_RECORD_TYPE[recordType];
  if (!status) {
    return c.json({ received: true, applied: false });
  }
  const updated = await updateCommDeliveryStatus(messageId, status);
  return c.json({ received: true, applied: updated > 0 });
});

export { postmarkWebhookRouter };
