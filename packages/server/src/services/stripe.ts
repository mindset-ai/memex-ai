// spec-171 t-3: Stripe integration — hand-rolled fetch calls, no stripe npm package (std-13).
import { createHmac, timingSafeEqual } from "node:crypto";

const STRIPE_API = "https://api.stripe.com/v1";
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

// ── Minimal Stripe response types ─────────────────────────────────────────────

interface StripeCustomer {
  id: string;
  object: "customer";
}

export interface StripeSubscription {
  id: string;
  object: "subscription";
  status: string;
  // Top-level on older API versions; newer versions moved the period boundary
  // onto each subscription item — the webhook reads whichever is populated.
  current_period_end?: number; // Unix timestamp
  items: {
    data: Array<{
      id: string;
      price: { id: string };
      quantity: number;
      current_period_end?: number;
    }>;
  };
}

/** Fetch a subscription by id (webhook uses this to derive plan/seats/period). */
export async function getSubscription(subscriptionId: string): Promise<StripeSubscription> {
  return stripeGet<StripeSubscription>(`/subscriptions/${subscriptionId}`);
}

interface StripeInvoice {
  amount_due: number;
  currency: string;
}

interface StripeBillingPortalSession {
  id: string;
  url: string;
}

interface StripeCheckoutSession {
  id: string;
  object: "checkout.session";
  url: string | null;
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

export type Plan = "premium" | "enterprise";
export type BillingCycle = "monthly" | "annual";

function priceEnvVar(plan: Plan, billingCycle: BillingCycle): string {
  return plan === "premium"
    ? billingCycle === "annual"
      ? "STRIPE_PREMIUM_ANNUAL_PRICE_ID"
      : "STRIPE_PREMIUM_MONTHLY_PRICE_ID"
    : billingCycle === "annual"
      ? "STRIPE_ENTERPRISE_ANNUAL_PRICE_ID"
      : "STRIPE_ENTERPRISE_MONTHLY_PRICE_ID";
}

function getPriceId(plan: Plan, billingCycle: BillingCycle): string {
  const envVar = priceEnvVar(plan, billingCycle);
  const id = process.env[envVar];
  if (!id) throw new Error(`${envVar} is not set`);
  return id;
}

/**
 * Reverse the price-id → (plan, billingCycle) mapping by inverting the same
 * four env vars getPriceId reads. The webhook uses this to derive the plan
 * tier from the subscription Stripe reports after a Checkout completes —
 * the price id is the single source of truth, not anything the client sent.
 * Returns null for an unrecognised price (e.g. a price retired from .env).
 */
export function resolvePlanFromPriceId(
  priceId: string,
): { plan: Plan; billingCycle: BillingCycle } | null {
  const combos: Array<{ plan: Plan; billingCycle: BillingCycle }> = [
    { plan: "premium", billingCycle: "monthly" },
    { plan: "premium", billingCycle: "annual" },
    { plan: "enterprise", billingCycle: "monthly" },
    { plan: "enterprise", billingCycle: "annual" },
  ];
  for (const combo of combos) {
    if (process.env[priceEnvVar(combo.plan, combo.billingCycle)] === priceId) {
      return combo;
    }
  }
  return null;
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

export async function stripeGet<T>(path: string): Promise<T> {
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
 * Create a Stripe Checkout Session (hosted redirect) for a subscription
 * purchase — spec-171 dec-38 / ac-33. The card is collected on Stripe's
 * hosted page, so no raw card / PaymentMethod data ever touches our server
 * (std-13). The subscription record is NOT written here — it lands via the
 * `checkout.session.completed` webhook once payment succeeds.
 *
 * The org's Stripe customer MUST already exist (created + persisted by the
 * caller) so we always pass `customer`. With an existing customer that has
 * no saved address, `automatic_tax` (ac-10/dec-12 — Stripe Tax) requires
 * `customer_update[address]=auto` so Checkout saves the billing address it
 * collects back onto the Customer; without it Stripe rejects the session.
 * Adaptive Pricing + Stripe Tax (enabled on the account) then handle local
 * currency + tax automatically.
 */
export async function createCheckoutSession(args: {
  customerId: string;
  orgId: string;
  plan: Plan;
  seats: number;
  billingCycle: BillingCycle;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ id: string; url: string }> {
  const { customerId, orgId, plan, seats, billingCycle, successUrl, cancelUrl } = args;
  const priceId = getPriceId(plan, billingCycle);

  const session = await stripePost<StripeCheckoutSession>("/checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    "customer_update[address]": "auto",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": String(seats),
    "automatic_tax[enabled]": "true",
    client_reference_id: orgId,
    "subscription_data[metadata][org_id]": orgId,
    "subscription_data[metadata][tier]": plan,
    "subscription_data[metadata][seats]": String(seats),
    "metadata[org_id]": orgId,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  if (!session.url) {
    throw new Error("Stripe Checkout session created without a redirect URL");
  }
  return { id: session.id, url: session.url };
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
