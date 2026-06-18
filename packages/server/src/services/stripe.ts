// spec-171 t-3: Stripe integration — hand-rolled fetch calls, no stripe npm package (std-13).
import { createHmac, timingSafeEqual } from "node:crypto";

const STRIPE_API = "https://api.stripe.com/v1";
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

// ── Minimal Stripe response types ─────────────────────────────────────────────

interface StripeCustomer {
  id: string;
  object: "customer";
}

interface StripeSubscription {
  id: string;
  object: "subscription";
  status: string;
  current_period_end: number; // Unix timestamp
  items: { data: Array<{ id: string; price: { id: string }; quantity: number }> };
}

interface StripeInvoice {
  amount_due: number;
  currency: string;
}

interface StripeBillingPortalSession {
  id: string;
  url: string;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly stripeError: { type?: string; message?: string; code?: string },
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

function getStripeSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return key;
}

function getWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return secret;
}

function getPriceId(plan: "premium" | "enterprise", billingCycle: "monthly" | "annual"): string {
  const envVar =
    plan === "premium"
      ? billingCycle === "annual"
        ? "STRIPE_PREMIUM_ANNUAL_PRICE_ID"
        : "STRIPE_PREMIUM_MONTHLY_PRICE_ID"
      : billingCycle === "annual"
        ? "STRIPE_ENTERPRISE_ANNUAL_PRICE_ID"
        : "STRIPE_ENTERPRISE_MONTHLY_PRICE_ID";
  const id = process.env[envVar];
  if (!id) throw new Error(`${envVar} is not set`);
  return id;
}

async function stripePost<T>(path: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getStripeSecretKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    let parsed: { error?: { type?: string; message?: string; code?: string } } = {};
    try { parsed = await res.json(); } catch { /* ignore parse failure */ }
    throw new StripeApiError(
      res.status,
      parsed.error ?? {},
      `Stripe POST ${path} failed (${res.status}): ${parsed.error?.message ?? "<unreadable>"}`,
    );
  }
  return res.json() as Promise<T>;
}

async function stripeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${getStripeSecretKey()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`Stripe GET ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Create a Stripe Customer for a new org. Returns the Stripe customer ID. */
export async function createStripeCustomer(
  email: string,
  orgName: string,
  orgId: string,
): Promise<string> {
  const customer = await stripePost<StripeCustomer>("/customers", {
    email,
    name: orgName,
    "metadata[org_id]": orgId,
  });
  return customer.id;
}

/**
 * Create a Stripe Subscription for an org. Uses `proration_behavior:
 * create_prorations` per dec-11. Stripe Tax is applied via the price's
 * tax behaviour setting (tax code txcd_10000000 configured on the price
 * in the Stripe dashboard per dec-12).
 */
export async function createSubscription(
  customerId: string,
  plan: "premium" | "enterprise",
  seats: number,
  billingCycle: "monthly" | "annual",
): Promise<{ subscriptionId: string; currentPeriodEnd: number }> {
  const priceId = getPriceId(plan, billingCycle);
  const subscription = await stripePost<StripeSubscription>("/subscriptions", {
    customer: customerId,
    "items[0][price]": priceId,
    "items[0][quantity]": String(seats),
    proration_behavior: "create_prorations",
    "payment_settings[payment_method_types][0]": "card",
    "expand[0]": "latest_invoice.payment_intent",
  });
  return { subscriptionId: subscription.id, currentPeriodEnd: subscription.current_period_end };
}

/** Attach a Stripe PaymentMethod to a customer and set it as their default. */
export async function attachPaymentMethod(
  customerId: string,
  paymentMethodId: string,
): Promise<void> {
  await stripePost(`/payment_methods/${paymentMethodId}/attach`, {
    customer: customerId,
  });
  await stripePost(`/customers/${customerId}`, {
    "invoice_settings[default_payment_method]": paymentMethodId,
  });
}

/** Update the seat count on an existing subscription (self-service per dec-29). */
export async function updateSubscriptionSeats(
  subscriptionId: string,
  seats: number,
): Promise<void> {
  const subscription = await stripeGet<StripeSubscription>(
    `/subscriptions/${subscriptionId}`,
  );
  const itemId = subscription.items.data[0]?.id;
  if (!itemId) throw new Error(`No subscription item found on ${subscriptionId}`);

  await stripePost(`/subscriptions/${subscriptionId}`, {
    "items[0][id]": itemId,
    "items[0][quantity]": String(seats),
    proration_behavior: "create_prorations",
  });
}

/**
 * Preview the upcoming invoice for a seat-count change. Used to show the
 * prorated charge/credit before the customer confirms (dec-29 confirmation prompt).
 */
export async function previewUpcomingInvoice(
  customerId: string,
  subscriptionId: string,
  seats: number,
): Promise<{ amountDue: number; currency: string }> {
  const subscription = await stripeGet<StripeSubscription>(
    `/subscriptions/${subscriptionId}`,
  );
  const itemId = subscription.items.data[0]?.id;
  if (!itemId) throw new Error(`No subscription item found on ${subscriptionId}`);

  const params = new URLSearchParams({
    customer: customerId,
    subscription: subscriptionId,
    "subscription_items[0][id]": itemId,
    "subscription_items[0][quantity]": String(seats),
  });
  const res = await fetch(`${STRIPE_API}/invoices/upcoming?${params.toString()}`, {
    headers: { Authorization: `Bearer ${getStripeSecretKey()}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`Stripe GET /invoices/upcoming failed (${res.status}): ${text}`);
  }
  const invoice = (await res.json()) as StripeInvoice;
  return { amountDue: invoice.amount_due, currency: invoice.currency };
}

/**
 * Create a Stripe Billing Portal session so customers can manage their payment
 * method and view invoices (Settings > Org > Billing per c-10).
 */
export async function createBillingPortalSession(
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const session = await stripePost<StripeBillingPortalSession>(
    "/billing_portal/sessions",
    { customer: customerId, return_url: returnUrl },
  );
  return session.url;
}

/**
 * Verify an inbound Stripe webhook signature and return the parsed event.
 * Throws if the signature is invalid, missing, or the timestamp is outside
 * the 5-minute tolerance. Uses HMAC-SHA256 via node:crypto (no Stripe SDK).
 *
 * Stripe-Signature header format: t=<unix_ts>,v1=<hex_sig>[,v0=<legacy>]
 */
export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string,
): StripeWebhookEvent {
  const secret = getWebhookSecret();
  const parts = signatureHeader.split(",");

  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v1 = parts.find((p) => p.startsWith("v1="))?.slice(3);

  if (!timestamp || !v1) {
    throw new Error("Invalid Stripe-Signature header: missing t or v1");
  }

  // Timestamp tolerance check
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new Error("Stripe webhook timestamp is outside the 5-minute tolerance");
  }

  // HMAC-SHA256 of "<timestamp>.<rawBody>"
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  // Timing-safe comparison
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(v1, "hex");
  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
    throw new Error("Stripe webhook signature verification failed");
  }

  return JSON.parse(rawBody) as StripeWebhookEvent;
}
