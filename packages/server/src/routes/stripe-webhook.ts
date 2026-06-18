// spec-171 t-3: Stripe webhook receiver.
//
// Mounted at /api/stripe/webhook (flat, no tenancy prefix — Stripe calls this
// directly). NO sessionMiddleware — the Stripe-Signature HMAC IS the auth.
//
// Idempotency: every event is recorded in stripe_events before handling. The
// unique constraint on event_id causes a duplicate insert to throw, which we
// catch and return 200 (Stripe expects 2xx on duplicates to stop retrying).

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { stripeEvents, orgs } from "../db/schema.js";
import { verifyStripeWebhookSignature } from "../services/stripe.js";

const stripeWebhookRouter = new Hono();

stripeWebhookRouter.post("/", async (c) => {
  // Hono parses the body lazily — read the raw text before any json() call so
  // the signature covers the exact bytes Stripe sent (whitespace and all).
  const rawBody = await c.req.text();
  const sigHeader = c.req.header("stripe-signature");

  if (!sigHeader) {
    return c.json({ error: "Missing Stripe-Signature header" }, 400);
  }

  let event;
  try {
    event = verifyStripeWebhookSignature(rawBody, sigHeader);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signature verification failed";
    return c.json({ error: message }, 400);
  }

  // Idempotency — record first, handle second. The UNIQUE constraint on event_id
  // means a duplicate insert throws; we treat that as "already processed → 200".
  try {
    await db.insert(stripeEvents).values({
      eventId: event.id,
      eventType: event.type,
    });
  } catch (err: unknown) {
    // PostgreSQL unique_violation error code 23505
    if (isUniqueViolation(err)) {
      return c.json({ received: true, duplicate: true });
    }
    throw err;
  }

  await handleStripeEvent(event.type, event.data.object);

  return c.json({ received: true });
});

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleStripeEvent(
  type: string,
  object: Record<string, unknown>,
): Promise<void> {
  switch (type) {
    case "invoice.payment_failed":
      await handlePaymentFailed(object);
      break;
    case "invoice.payment_succeeded":
      // No action needed beyond recording the event — Stripe manages the
      // subscription status automatically on success.
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(object);
      break;
    default:
      // Unhandled event types — log and return 200 so Stripe stops retrying.
      console.warn(`[stripe-webhook] unhandled event type: ${type}`);
  }
}

async function handlePaymentFailed(invoice: Record<string, unknown>): Promise<void> {
  // Log the failure. A future task will send a payment-failure email via the
  // trial email cadence service (spec-171 t-5 / ac-41).
  const customerId =
    typeof invoice.customer === "string" ? invoice.customer : "<unknown>";
  const amountDue =
    typeof invoice.amount_due === "number" ? invoice.amount_due : null;
  const currency =
    typeof invoice.currency === "string" ? invoice.currency : null;

  console.error(
    `[stripe-webhook] payment_failed customer=${customerId} amount=${amountDue} ${currency}`,
  );
}

async function handleSubscriptionDeleted(subscription: Record<string, unknown>): Promise<void> {
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : null;
  if (!customerId) {
    console.warn("[stripe-webhook] subscription.deleted event missing customer ID");
    return;
  }
  await db
    .update(orgs)
    .set({ planTier: null, stripeSubscriptionId: null, seatsPurchased: null })
    .where(eq(orgs.stripeCustomerId, customerId));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "23505";
  }
  return false;
}

export { stripeWebhookRouter };
