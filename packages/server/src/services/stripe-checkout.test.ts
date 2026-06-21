// spec-171 t-18 — hosted purchase via Stripe Checkout (dec-38 / ac-33).
//
// Two-pronged verification of ac-33:
//   (1) POSITIVE — createCheckoutSession POSTs a subscription-mode session with
//       Stripe Tax enabled, the correct price + quantity, and org_id metadata,
//       and returns the hosted redirect URL.
//   (2) NEGATIVE (source/AST guard) — no raw card / PaymentMethod path survives
//       on the server: attachPaymentMethod is gone from the stripe service and
//       the orgs subscription route no longer accepts paymentMethodId. A mocked
//       fetch can't prove the absence of a behaviour, so this is asserted
//       against the source text — the honest shape for a scope-style AC.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { createCheckoutSession } from "./stripe.js";

const AC_33 = "mindset-prod/memex-building-itself/specs/spec-171/acs/ac-33";

const HERE = dirname(fileURLToPath(import.meta.url));

let captured: { url: string; body: URLSearchParams } | null = null;

beforeEach(() => {
  captured = null;
  // Pin the price-id env vars so the helper resolves a deterministic price.
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID = "price_premium_monthly";
  process.env.STRIPE_PREMIUM_ANNUAL_PRICE_ID = "price_premium_annual";
  process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = "price_ent_monthly";
  process.env.STRIPE_ENTERPRISE_ANNUAL_PRICE_ID = "price_ent_annual";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, body: new URLSearchParams(init.body as string) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "cs_test_123",
          object: "checkout.session",
          url: "https://checkout.stripe.com/c/pay/cs_test_123",
        }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spec-171 ac-33: hosted Stripe Checkout (no raw card on our server)", () => {
  it("createCheckoutSession POSTs a subscription session with tax, price, quantity and org_id metadata", async () => {
    tagAc(AC_33);

    const result = await createCheckoutSession({
      customerId: "cus_abc",
      orgId: "org-uuid-1",
      plan: "premium",
      seats: 7,
      billingCycle: "annual",
      successUrl: "https://memex.ai/upgrade/confirmation?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://memex.ai/upgrade/premium",
    });

    // Hit the Checkout Sessions endpoint.
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://api.stripe.com/v1/checkout/sessions");

    const body = captured!.body;
    // Hosted subscription mode (dec-38) — not a one-time payment.
    expect(body.get("mode")).toBe("subscription");
    // Stripe Tax enabled (ac-10 / dec-12), with customer_update so an existing
    // customer without an address doesn't reject the session.
    expect(body.get("automatic_tax[enabled]")).toBe("true");
    expect(body.get("customer_update[address]")).toBe("auto");
    // Correct price (annual premium) + quantity.
    expect(body.get("line_items[0][price]")).toBe("price_premium_annual");
    expect(body.get("line_items[0][quantity]")).toBe("7");
    // org_id carried both as session metadata and on the subscription, so the
    // webhook can resolve the org regardless of which it reads.
    expect(body.get("metadata[org_id]")).toBe("org-uuid-1");
    expect(body.get("subscription_data[metadata][org_id]")).toBe("org-uuid-1");
    expect(body.get("client_reference_id")).toBe("org-uuid-1");
    // Existing customer is always passed (never customer_email/customer_creation).
    expect(body.get("customer")).toBe("cus_abc");
    expect(body.has("customer_creation")).toBe(false);

    // Returns the hosted redirect URL for the browser.
    expect(result.url).toBe("https://checkout.stripe.com/c/pay/cs_test_123");

    // No raw card / PaymentMethod data is ever sent from our server.
    for (const [key] of body.entries()) {
      expect(key).not.toMatch(/card|payment_method|paymentMethod/i);
    }
  });

  it("no raw-card path survives on the server (source guard)", () => {
    tagAc(AC_33);

    const stripeSrc = readFileSync(resolve(HERE, "stripe.ts"), "utf8");
    // The Card-Element era attach helper must be gone.
    expect(stripeSrc).not.toMatch(/attachPaymentMethod/);
    // No raw-card subscription creation path (the hosted session replaces it).
    expect(stripeSrc).not.toMatch(/payment_methods\/\$\{/);

    const orgsSrc = readFileSync(resolve(HERE, "../routes/orgs.ts"), "utf8");
    // The subscription route no longer accepts or reads a PaymentMethod id.
    expect(orgsSrc).not.toMatch(/paymentMethodId/);
  });
});
