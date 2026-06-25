// spec-171 t-3: Stripe webhook receiver.
//
// Mounted at /api/stripe/webhook (flat, no tenancy prefix — Stripe calls this
// directly). NO sessionMiddleware — the Stripe-Signature HMAC IS the auth.
//
// Idempotency (spec-171 t-23 / issue-6): the stripe_events insert and the handler
// run inside ONE transaction. A failed handler rolls back the idempotency row so
// Stripe's retry re-processes the event; a genuine duplicate (event_id already
// recorded) is detected via INSERT ... ON CONFLICT DO NOTHING and answered 200
// (Stripe expects 2xx on duplicates to stop retrying).

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { stripeEvents, orgs } from "../db/schema.js";
import {
  verifyStripeWebhookSignature,
  getSubscription,
  resolvePlanFromPriceId,
  type StripeSubscription,
} from "../services/stripe.js";
import { recordStripeEmailComm } from "../services/comms-log.js";

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

  // Idempotency must be ATOMIC (spec-171 t-23 / issue-6). Record + handle in ONE
  // transaction so that if the handler throws (e.g. a transient getSubscription
  // failure on the sole purchase-persistence path) the transaction rolls back —
  // the stripe_events row is NOT persisted, the endpoint returns a non-2xx, and
  // Stripe's retry re-processes the event instead of being rejected as a duplicate.
  //
  // Duplicate detection uses INSERT ... ON CONFLICT DO NOTHING on the event_id
  // unique index, NOT a catch on the 23505 error. That distinction matters: a
  // handler's own DB write can legitimately raise 23505 (e.g. orgs has a UNIQUE
  // on stripe_customer_id, and handleCheckoutCompleted writes it) — catching the
  // code would misclassify that real failure as "already processed → 200" and
  // re-introduce the dropped-purchase bug one layer down. With onConflictDoNothing
  // the only thing that signals a duplicate is an empty `returning()` from the
  // insert; any error from the handler propagates as a non-2xx so Stripe retries.
  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(stripeEvents)
      .values({ eventId: event.id, eventType: event.type })
      .onConflictDoNothing({ target: stripeEvents.eventId })
      .returning({ eventId: stripeEvents.eventId });

    // Empty result ⇒ event_id already recorded by a prior successful run ⇒ this
    // is a genuine duplicate delivery. Don't run the handler again; the outer
    // 200 tells Stripe to stop retrying.
    if (rows.length === 0) return false;

    await handleStripeEvent(event.type, event.data.object);
    return true;
  });

  if (!inserted) {
    return c.json({ received: true, duplicate: true });
  }

  return c.json({ received: true });
});

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleStripeEvent(
  type: string,
  object: Record<string, unknown>,
): Promise<void> {
  switch (type) {
    case "checkout.session.completed":
      // spec-171 dec-38: the hosted Checkout finished + paid. This is the
      // authoritative moment the subscription row is written — NOT the POST
      // that created the session.
      await handleCheckoutCompleted(object);
      break;
    case "customer.subscription.updated":
      // Seat count changed (or any other subscription mutation) — keep
      // seats_purchased in sync with Stripe's view.
      await handleSubscriptionUpdated(object);
      break;
    case "invoice.payment_failed":
      await handlePaymentFailed(object);
      break;
    case "invoice.payment_succeeded":
      // spec-341 t-4: "Successful payments" receipt email is ON (Settings → Email,
      // confirmed 2026-06-23) — Stripe emails the customer a receipt — so record it.
      await handlePaymentSucceeded(object);
      break;
    case "invoice.upcoming":
      // spec-341 t-4: "Send emails about upcoming renewals" is ON (7 days before),
      // so Stripe emails a renewal reminder — record it in the comms log.
      await handleUpcomingRenewal(object);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(object);
      break;
    default:
      // Unhandled event types — log and return 200 so Stripe stops retrying.
      console.warn(`[stripe-webhook] unhandled event type: ${type}`);
  }
}

export async function handleCheckoutCompleted(
  session: Record<string, unknown>,
): Promise<void> {
  // org_id rides on session.metadata.org_id (we set it) with client_reference_id
  // as a fallback (we set that too).
  const orgId = resolveOrgId(session);
  if (!orgId) {
    console.warn("[stripe-webhook] checkout.session.completed missing org_id");
    return;
  }

  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : null;
  const customerId = typeof session.customer === "string" ? session.customer : null;
  if (!subscriptionId) {
    console.warn(
      `[stripe-webhook] checkout.session.completed org=${orgId} missing subscription id`,
    );
    return;
  }

  // The price id Stripe reports is the single source of truth for the plan —
  // not anything the client sent. Read the subscription to derive it.
  const subscription = await getSubscription(subscriptionId);
  const priceId = subscription.items.data[0]?.price?.id;
  const plan = priceId ? resolvePlanFromPriceId(priceId)?.plan : null;
  if (!plan) {
    console.warn(
      `[stripe-webhook] checkout.session.completed org=${orgId} unknown price=${priceId}`,
    );
    return;
  }
  const seats = subscription.items.data[0]?.quantity ?? null;

  await db
    .update(orgs)
    .set({
      planTier: plan,
      stripeSubscriptionId: subscriptionId,
      seatsPurchased: seats,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
    })
    .where(eq(orgs.id, orgId));
}

export async function handleSubscriptionUpdated(
  subscription: Record<string, unknown>,
): Promise<void> {
  // Trust the typed shape we already model — quantity + customer live where
  // updateSubscriptionSeats reads them.
  const sub = subscription as unknown as StripeSubscription & { customer?: unknown };
  const customerId = typeof sub.customer === "string" ? sub.customer : null;
  if (!customerId) {
    console.warn("[stripe-webhook] subscription.updated event missing customer ID");
    return;
  }
  const seats = sub.items?.data?.[0]?.quantity ?? null;
  if (seats === null) {
    console.warn(
      `[stripe-webhook] subscription.updated customer=${customerId} missing quantity`,
    );
    return;
  }
  await db
    .update(orgs)
    .set({ seatsPurchased: seats })
    .where(eq(orgs.stripeCustomerId, customerId));
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

  // spec-341 t-4: Stripe emails the customer a dunning notice on payment failure.
  // Record it in the comms log for the billing-contact user (best-effort, dec-3).
  if (typeof invoice.customer === "string") {
    const invoiceId = typeof invoice.id === "string" ? invoice.id : null;
    await recordStripeEmailComm({
      customerId: invoice.customer,
      commsType: "transactional",
      subject: "Payment failed",
      sourceRef: invoiceId ? `stripe:${invoiceId}:failed` : undefined,
    });
  }
}

// spec-341 t-4: Stripe emails a renewal reminder ~7 days before a subscription
// renews ("Send emails about upcoming renewals" is ON). Record it in the comms log
// for the billing-contact user (best-effort, dec-3). Advisory — recordStripeEmailComm
// swallows its own errors so this never affects the webhook. (An upcoming invoice is
// a preview with no id, so the source_ref falls back to stripe:<customerId>.)
async function handleUpcomingRenewal(invoice: Record<string, unknown>): Promise<void> {
  if (typeof invoice.customer !== "string") return;
  await recordStripeEmailComm({
    customerId: invoice.customer,
    commsType: "transactional",
    subject: "Upcoming renewal",
  });
}

// spec-341 t-4: Stripe emails a receipt on a successful invoice payment
// ("Successful payments" is ON). Record it in the comms log for the billing-contact
// user (best-effort, dec-3). Advisory — recordStripeEmailComm swallows its own errors.
async function handlePaymentSucceeded(invoice: Record<string, unknown>): Promise<void> {
  if (typeof invoice.customer !== "string") return;
  const invoiceId = typeof invoice.id === "string" ? invoice.id : null;
  await recordStripeEmailComm({
    customerId: invoice.customer,
    commsType: "transactional",
    subject: "Payment receipt",
    sourceRef: invoiceId ? `stripe:${invoiceId}` : undefined,
  });
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

function resolveOrgId(session: Record<string, unknown>): string | null {
  const metadata = session.metadata;
  if (metadata && typeof metadata === "object" && "org_id" in metadata) {
    const fromMeta = (metadata as Record<string, unknown>).org_id;
    if (typeof fromMeta === "string" && fromMeta) return fromMeta;
  }
  if (typeof session.client_reference_id === "string" && session.client_reference_id) {
    return session.client_reference_id;
  }
  return null;
}

export { stripeWebhookRouter };
