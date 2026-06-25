// spec-171 issue-15 — GET /current/subscription surfaces billing cycle + next
// billing date.
//
// The webhook persists planTier/seatsPurchased/stripeSubscriptionId but NOT the
// billing interval or current_period_end, so the /org billing page rendered "—"
// for "Billing cycle" and "Next billing date". The GET endpoint now retrieves
// the live Stripe subscription (when there is one) and derives:
//   - billingCycle  ← the price id, via resolvePlanFromPriceId (same source of
//                     truth the webhook uses for the tier)
//   - currentPeriodEnd ← current_period_end (unix → ISO)
//
// This suite proves:
//   (1) an org WITH a subscription → cycle + next-date are present (Stripe mocked).
//   (2) a free org (no subscription) → both null, Stripe never called.
//   (3) resilience: a Stripe failure does NOT 500 — we return the persisted data
//       with cycle/date null.
//
// Mirrors orgs.subscription-guard.integration.test.ts: real Postgres org rows,
// the Stripe network surface mocked via vi.mock + importOriginal, dev-mode
// session auto-resolves the single admin membership so adminGate passes.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, users } from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";

// NOTE: issue-15 (surface billing cycle + next-date on the GET) has no dedicated
// spec-171 AC — the closest, ac-39, is about which org the checkout targets
// (issue-16), not the GET enrichment. Rather than mis-tag an unrelated AC, this
// suite is left untagged; it still runs in CI as a plain integration test.

// Force dev mode so sessionMiddleware logs in as dev@memex.ai without a real JWT.
const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});

// Mock only getSubscription; everything else in stripe.js stays real so the
// real resolvePlanFromPriceId runs against the env price ids set below.
const { getSubscriptionMock } = vi.hoisted(() => ({
  getSubscriptionMock: vi.fn(),
}));
vi.mock("../services/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stripe.js")>();
  return {
    ...actual,
    getSubscription: getSubscriptionMock,
  };
});

import { Hono } from "hono";
import { orgsCurrentRouter } from "./orgs.js";
import { errorHandler } from "../middleware/error-handler.js";

const app = new Hono();
app.onError(errorHandler);
app.route("/api/orgs", orgsCurrentRouter);

// resolvePlanFromPriceId reads these env vars; pin them so the real mapping runs.
const ANNUAL_PRICE = "price_premium_annual_test";
const originalAnnualPrice = process.env.STRIPE_PREMIUM_ANNUAL_PRICE_ID;
beforeAll(() => {
  process.env.STRIPE_PREMIUM_ANNUAL_PRICE_ID = ANNUAL_PRICE;
});

const createdMemexIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
  if (originalAnnualPrice !== undefined) {
    process.env.STRIPE_PREMIUM_ANNUAL_PRICE_ID = originalAnnualPrice;
  } else {
    delete process.env.STRIPE_PREMIUM_ANNUAL_PRICE_ID;
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdMemexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  }
});

beforeEach(() => {
  getSubscriptionMock.mockReset();
});

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

async function seedOrgWithAdmin(orgPatch: Partial<typeof orgs.$inferInsert>): Promise<{ orgId: string }> {
  const slug = uniqueSlug("billing");
  const dev = await upsertUserByEmail("dev@memex.ai");
  if (!createdUserIds.includes(dev.id)) createdUserIds.push(dev.id);

  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: "Billing Test Org", stripeCustomerId: `cus_${slug}`, ...orgPatch })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Billing Test" }).returning();
  createdMemexIds.push(mx.id);

  await db.delete(orgMemberships).where(eq(orgMemberships.userId, dev.id));
  await db.update(users).set({ namespaceId: null }).where(eq(users.id, dev.id));
  await db.delete(namespaces).where(eq(namespaces.ownerUserId, dev.id));
  await db.update(users).set({ namespaceId: ns.id }).where(eq(users.id, dev.id));
  await db.insert(orgMemberships).values({ userId: dev.id, orgId: org.id, role: "administrator" });

  return { orgId: org.id };
}

async function getSubscriptionEndpoint(): Promise<Response> {
  return app.request("/api/orgs/current/subscription", {
    headers: { "content-type": "application/json" },
  });
}

interface SubBody {
  tier: string;
  seatsPurchased: number | null;
  billingCycle: "monthly" | "annual" | null;
  currentPeriodEnd: string | null;
}

describe("spec-171 issue-15: GET subscription surfaces cycle + next billing date", () => {
  it("returns billingCycle + currentPeriodEnd when the org has a live subscription", async () => {

    await seedOrgWithAdmin({
      stripeSubscriptionId: "sub_live_123",
      planTier: "premium",
      seatsPurchased: 5,
    });

    const periodEndUnix = 1_750_000_000; // arbitrary fixed unix ts
    getSubscriptionMock.mockResolvedValue({
      id: "sub_live_123",
      object: "subscription",
      status: "active",
      current_period_end: periodEndUnix,
      items: { data: [{ id: "si_1", price: { id: ANNUAL_PRICE }, quantity: 5 }] },
    });

    const res = await getSubscriptionEndpoint();
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubBody;

    expect(getSubscriptionMock).toHaveBeenCalledWith("sub_live_123");
    expect(body.tier).toBe("premium");
    expect(body.billingCycle).toBe("annual");
    expect(body.currentPeriodEnd).toBe(new Date(periodEndUnix * 1000).toISOString());
  });

  it("reads current_period_end off the first item when the top-level field is absent", async () => {

    await seedOrgWithAdmin({
      stripeSubscriptionId: "sub_item_period",
      planTier: "premium",
      seatsPurchased: 2,
    });

    const periodEndUnix = 1_760_000_000;
    getSubscriptionMock.mockResolvedValue({
      id: "sub_item_period",
      object: "subscription",
      status: "active",
      // no top-level current_period_end (newer API versions)
      items: {
        data: [{ id: "si_1", price: { id: ANNUAL_PRICE }, quantity: 2, current_period_end: periodEndUnix }],
      },
    });

    const res = await getSubscriptionEndpoint();
    const body = (await res.json()) as SubBody;
    expect(body.currentPeriodEnd).toBe(new Date(periodEndUnix * 1000).toISOString());
    expect(body.billingCycle).toBe("annual");
  });

  it("returns nulls and never calls Stripe for a free org with no subscription", async () => {

    await seedOrgWithAdmin({
      stripeSubscriptionId: null,
      planTier: null,
      seatsPurchased: null,
    });

    const res = await getSubscriptionEndpoint();
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubBody;

    expect(getSubscriptionMock).not.toHaveBeenCalled();
    expect(body.tier).toBe("free");
    expect(body.billingCycle).toBeNull();
    expect(body.currentPeriodEnd).toBeNull();
  });

  it("does not 500 the billing page when the Stripe fetch fails", async () => {

    await seedOrgWithAdmin({
      stripeSubscriptionId: "sub_stripe_down",
      planTier: "premium",
      seatsPurchased: 4,
    });

    getSubscriptionMock.mockRejectedValue(new Error("Stripe is down"));

    const res = await getSubscriptionEndpoint();
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubBody;

    // Persisted data still comes back; only the live-derived fields fall to null.
    expect(body.tier).toBe("premium");
    expect(body.seatsPurchased).toBe(4);
    expect(body.billingCycle).toBeNull();
    expect(body.currentPeriodEnd).toBeNull();
  });
});
