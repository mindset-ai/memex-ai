// spec-171 t-18 — webhook persistence is the SOLE source of truth for a hosted
// purchase (dec-38). The POST endpoint only creates the Checkout Session; the
// `checkout.session.completed` webhook writes plan_tier / stripe_subscription_id
// / seats_purchased. This suite exercises that persistence against a real org
// row, with the Stripe `/subscriptions/{id}` read stubbed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, orgs } from "../db/schema.js";

const AC_33 = "mindset-prod/memex-building-itself/specs/spec-171/acs/ac-33";

// Pin price ids so resolvePlanFromPriceId resolves deterministically. Set before
// importing the service (it reads process.env at call time, so order is lenient,
// but be explicit).
process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID = "price_premium_monthly";
process.env.STRIPE_PREMIUM_ANNUAL_PRICE_ID = "price_premium_annual";
process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = "price_ent_monthly";
process.env.STRIPE_ENTERPRISE_ANNUAL_PRICE_ID = "price_ent_annual";

// Stub only the Stripe network read; resolvePlanFromPriceId stays real.
// vi.hoisted so the mock fn exists when the hoisted vi.mock factory runs.
const { getSubscriptionMock } = vi.hoisted(() => ({ getSubscriptionMock: vi.fn() }));
vi.mock("../services/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stripe.js")>();
  return { ...actual, getSubscription: getSubscriptionMock };
});

import { tagAc } from "@memex-ai-ac/vitest";
import { handleCheckoutCompleted, handleSubscriptionUpdated } from "./stripe-webhook.js";

async function seedOrg(): Promise<{ orgId: string }> {
  const slug = `whk-${Math.random().toString(36).slice(2, 10)}`;
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: "Webhook Test Org", stripeCustomerId: `cus_${slug}` })
    .returning();
  return { orgId: org.id };
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
