// spec-171 t-24 / issue-7 — re-purchase double-bill guard (ac-38).
//
// The POST /current/subscription endpoint (t-18) opens a Stripe Checkout
// Session. Without a guard, an org that ALREADY has an active subscription
// could hit it again and end up with a SECOND Stripe subscription → double
// billing. This suite proves:
//   (1) an org with an existing subscription (stripeSubscriptionId set) →
//       the endpoint returns 409 and NEVER calls createCheckoutSession.
//   (2) the happy path still works: a free org (no subscription) → still gets
//       a Checkout Session URL back.
//
// Mirrors the webhook integration harness: real Postgres org rows, the Stripe
// service network calls mocked via vi.mock + importOriginal, and the route
// exercised through a flat-mounted orgsCurrentRouter. Dev-mode session
// (GOOGLE_CLIENT_ID unset) auto-resolves the single admin membership so
// adminGate passes — same trick as team.integration.test.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, users } from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";

const AC_38 = "mindset-prod/memex-building-itself/specs/spec-171/acs/ac-38";

// Force dev mode so sessionMiddleware logs in as dev@memex.ai without a real JWT.
const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});

// Mock only the Stripe network surface; everything else in stripe.js stays real.
// createCheckoutSession is a spy so we can assert it is NOT called for an org
// that already has a subscription.
const { createCheckoutSessionMock, createStripeCustomerMock } = vi.hoisted(() => ({
  createCheckoutSessionMock: vi.fn(),
  createStripeCustomerMock: vi.fn(),
}));
vi.mock("../services/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stripe.js")>();
  return {
    ...actual,
    createCheckoutSession: createCheckoutSessionMock,
    createStripeCustomer: createStripeCustomerMock,
  };
});

import { Hono } from "hono";
import { orgsCurrentRouter } from "./orgs.js";
import { errorHandler } from "../middleware/error-handler.js";

const app = new Hono();
app.onError(errorHandler);
// Flat-mount: the route path inside the router is `/current/subscription`.
app.route("/api/orgs", orgsCurrentRouter);

const createdMemexIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdMemexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  }
});

beforeEach(() => {
  createCheckoutSessionMock.mockReset();
  createCheckoutSessionMock.mockResolvedValue({
    url: "https://checkout.stripe.com/c/pay/cs_test_guard",
  });
  createStripeCustomerMock.mockReset();
  createStripeCustomerMock.mockResolvedValue("cus_created_by_endpoint");
});

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

// Seed a namespace + org + memex tuple with dev@memex.ai as the sole admin
// member, so sessionMiddleware auto-resolves currentMemexId/currentRole.
async function seedOrgWithAdmin(orgPatch: Partial<typeof orgs.$inferInsert>): Promise<{ orgId: string }> {
  const slug = uniqueSlug("sub");
  const dev = await upsertUserByEmail("dev@memex.ai");
  if (!createdUserIds.includes(dev.id)) createdUserIds.push(dev.id);

  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: "Guard Test Org", stripeCustomerId: `cus_${slug}`, ...orgPatch })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Guard Test" }).returning();
  createdMemexIds.push(mx.id);

  // Make THIS org the dev user's only membership so auto-resolve picks it.
  await db.delete(orgMemberships).where(eq(orgMemberships.userId, dev.id));
  await db.update(users).set({ namespaceId: null }).where(eq(users.id, dev.id));
  await db.delete(namespaces).where(eq(namespaces.ownerUserId, dev.id));
  await db.update(users).set({ namespaceId: ns.id }).where(eq(users.id, dev.id));
  await db.insert(orgMemberships).values({ userId: dev.id, orgId: org.id, role: "administrator" });

  return { orgId: org.id };
}

async function postCheckout(): Promise<Response> {
  return app.request("/api/orgs/current/subscription", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan: "premium", seats: 5, billingCycle: "monthly" }),
  });
}

describe("spec-171 ac-38: re-purchase double-bill guard", () => {
  it("blocks a second Checkout when the org already has an active subscription", async () => {
    tagAc(AC_38);

    await seedOrgWithAdmin({
      stripeSubscriptionId: "sub_existing_123",
      planTier: "premium",
      seatsPurchased: 3,
    });

    const res = await postCheckout();

    // No second Stripe subscription is ever opened.
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    // A clear 409 that points the admin at billing management — and is NOT the
    // adminGate multi-memex 409 (assert on the message, not just the status).
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/already has an active subscription/i);
  });

  it("still opens a Checkout Session for a free org with no subscription", async () => {
    tagAc(AC_38);

    await seedOrgWithAdmin({
      stripeSubscriptionId: null,
      planTier: null,
      seatsPurchased: null,
    });

    const res = await postCheckout();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toBe("https://checkout.stripe.com/c/pay/cs_test_guard");
    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
  });
});
