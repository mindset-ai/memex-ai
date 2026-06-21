// spec-171 t-18 — webhook persistence is the SOLE source of truth for a hosted
// purchase (dec-38). The POST endpoint only creates the Checkout Session; the
// `checkout.session.completed` webhook writes plan_tier / stripe_subscription_id
// / seats_purchased. This suite exercises that persistence against a real org
// row, with the Stripe `/subscriptions/{id}` read stubbed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, orgs, stripeEvents } from "../db/schema.js";

const AC_33 = "mindset-prod/memex-building-itself/specs/spec-171/acs/ac-33";
const AC_37 = "mindset-prod/memex-building-itself/specs/spec-171/acs/ac-37";

// Pin price ids so resolvePlanFromPriceId resolves deterministically. Set before
// importing the service (it reads process.env at call time, so order is lenient,
// but be explicit).
process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID = "price_premium_monthly";
process.env.STRIPE_PREMIUM_ANNUAL_PRICE_ID = "price_premium_annual";
process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = "price_ent_monthly";
process.env.STRIPE_ENTERPRISE_ANNUAL_PRICE_ID = "price_ent_annual";

// The webhook router verifies the Stripe-Signature HMAC for real (the test mock
// keeps verifyStripeWebhookSignature unstubbed), so pin a known secret and sign
// posted bodies with it.
const WEBHOOK_SECRET = "whsec_test_idempotency";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

// Stub only the Stripe network read; resolvePlanFromPriceId stays real.
// vi.hoisted so the mock fn exists when the hoisted vi.mock factory runs.
const { getSubscriptionMock } = vi.hoisted(() => ({ getSubscriptionMock: vi.fn() }));
vi.mock("../services/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stripe.js")>();
  return { ...actual, getSubscription: getSubscriptionMock };
});

import { tagAc } from "@memex-ai-ac/vitest";
import { handleCheckoutCompleted, handleSubscriptionUpdated, stripeWebhookRouter } from "./stripe-webhook.js";

async function seedOrg(): Promise<{ orgId: string }> {
  const slug = `whk-${Math.random().toString(36).slice(2, 10)}`;
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: "Webhook Test Org", stripeCustomerId: `cus_${slug}` })
    .returning();
  return { orgId: org.id };
}

// Build a valid Stripe-Signature header for `body` using the same HMAC-SHA256
// scheme verifyStripeWebhookSignature checks: signed over "<timestamp>.<body>".
function signedHeader(body: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

// POST a signed event through the actual webhook router (not the handler
// directly) — this exercises the idempotency insert + duplicate-catch path.
async function postEvent(event: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(event);
  return stripeWebhookRouter.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signedHeader(body),
    },
    body,
  });
}

beforeEach(() => {
  getSubscriptionMock.mockReset();
});

describe("spec-171 ac-33: webhook persists the hosted purchase", () => {
  it("checkout.session.completed writes plan tier, subscription id and seats from the resolved price", async () => {
    tagAc(AC_33);
    const { orgId } = await seedOrg();

    getSubscriptionMock.mockResolvedValue({
      id: "sub_live_1",
      object: "subscription",
      status: "active",
      items: {
        data: [{ id: "si_1", price: { id: "price_premium_annual" }, quantity: 9 }],
      },
    });

    await handleCheckoutCompleted({
      id: "cs_1",
      subscription: "sub_live_1",
      customer: "cus_x",
      metadata: { org_id: orgId },
    });

    const [row] = await db
      .select({
        planTier: orgs.planTier,
        stripeSubscriptionId: orgs.stripeSubscriptionId,
        seatsPurchased: orgs.seatsPurchased,
        stripeCustomerId: orgs.stripeCustomerId,
      })
      .from(orgs)
      .where(eq(orgs.id, orgId));

    expect(row.planTier).toBe("premium");
    expect(row.stripeSubscriptionId).toBe("sub_live_1");
    expect(row.seatsPurchased).toBe(9);
    expect(row.stripeCustomerId).toBe("cus_x");
  });

  it("falls back to client_reference_id when metadata.org_id is absent", async () => {
    tagAc(AC_33);
    const { orgId } = await seedOrg();

    getSubscriptionMock.mockResolvedValue({
      id: "sub_live_2",
      object: "subscription",
      status: "active",
      items: { data: [{ id: "si_2", price: { id: "price_ent_monthly" }, quantity: 3 }] },
    });

    await handleCheckoutCompleted({
      id: "cs_2",
      subscription: "sub_live_2",
      customer: "cus_y",
      client_reference_id: orgId,
    });

    const [row] = await db
      .select({ planTier: orgs.planTier, seatsPurchased: orgs.seatsPurchased })
      .from(orgs)
      .where(eq(orgs.id, orgId));
    expect(row.planTier).toBe("enterprise");
    expect(row.seatsPurchased).toBe(3);
  });

  it("customer.subscription.updated syncs seats_purchased by stripe customer id", async () => {
    tagAc(AC_33);
    const { orgId } = await seedOrg();
    // Activate the org first so we can observe the seat change.
    getSubscriptionMock.mockResolvedValue({
      id: "sub_live_3",
      object: "subscription",
      status: "active",
      items: { data: [{ id: "si_3", price: { id: "price_premium_monthly" }, quantity: 2 }] },
    });
    await handleCheckoutCompleted({
      id: "cs_3",
      subscription: "sub_live_3",
      customer: "cus_seat",
      metadata: { org_id: orgId },
    });
    // Re-point the org's customer to match the updated event.
    await db.update(orgs).set({ stripeCustomerId: "cus_seat" }).where(eq(orgs.id, orgId));

    await handleSubscriptionUpdated({
      id: "sub_live_3",
      object: "subscription",
      status: "active",
      customer: "cus_seat",
      items: { data: [{ id: "si_3", price: { id: "price_premium_monthly" }, quantity: 15 }] },
    });

    const [row] = await db
      .select({ seatsPurchased: orgs.seatsPurchased })
      .from(orgs)
      .where(eq(orgs.id, orgId));
    expect(row.seatsPurchased).toBe(15);
  });
});

// spec-171 t-23 / issue-6: webhook idempotency must be ATOMIC. The handler used
// to record the stripe_events row BEFORE handling, so a transient failure on the
// sole purchase-persistence path (getSubscription → orgs update) left the event
// recorded-as-seen → Stripe's retry was rejected as a duplicate → the paid
// purchase was silently dropped. The fix wraps insert+handle in one transaction
// so a thrown handler rolls back the idempotency row and the endpoint returns a
// non-2xx, leaving the retry free to re-process.
describe("spec-171 ac-37: webhook idempotency is atomic (issue-6)", () => {
  it("a failed handler does NOT persist the stripe_events row and returns non-2xx so Stripe retries", async () => {
    tagAc(AC_37);
    const { orgId } = await seedOrg();

    // Simulate a transient failure on the sole purchase-persistence path: the
    // event is valid (signature + org_id + subscription id all good) but the
    // getSubscription network read throws.
    getSubscriptionMock.mockRejectedValue(new Error("transient stripe outage"));

    const eventId = `evt_fail_${Math.random().toString(36).slice(2, 10)}`;
    const res = await postEvent({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_fail",
          subscription: "sub_fail",
          customer: "cus_fail",
          metadata: { org_id: orgId },
        },
      },
    });

    // (a) the endpoint did NOT succeed — Stripe sees a non-2xx and will retry.
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(500);

    // (b) NO stripe_events row exists for this event_id — the retry is therefore
    // NOT blocked as a duplicate. This is the assertion that fails pre-fix
    // (the row was inserted before the handler ran).
    const rows = await db
      .select({ eventId: stripeEvents.eventId })
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, eventId));
    expect(rows).toHaveLength(0);
  });

  it("a genuine duplicate delivery still returns 200 and does NOT re-run the handler", async () => {
    // Regression guard for the fix: the 23505 unique-violation must still
    // propagate out of db.transaction() so the duplicate-catch returns
    // 200 { duplicate: true } and the handler is not invoked a second time.
    tagAc(AC_37);
    const { orgId } = await seedOrg();

    getSubscriptionMock.mockResolvedValue({
      id: "sub_dup",
      object: "subscription",
      status: "active",
      items: { data: [{ id: "si_dup", price: { id: "price_premium_monthly" }, quantity: 4 }] },
    });

    const eventId = `evt_dup_${Math.random().toString(36).slice(2, 10)}`;
    const event = {
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_dup",
          subscription: "sub_dup",
          customer: "cus_dup",
          metadata: { org_id: orgId },
        },
      },
    };

    const first = await postEvent(event);
    expect(first.status).toBe(200);

    const second = await postEvent(event);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });

    // The handler ran exactly once — the duplicate was short-circuited, not
    // re-processed.
    expect(getSubscriptionMock).toHaveBeenCalledTimes(1);

    // Exactly one idempotency row landed.
    const rows = await db
      .select({ eventId: stripeEvents.eventId })
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, eventId));
    expect(rows).toHaveLength(1);
  });
});
