// spec-171 — seat-change Stripe integration (ac-9, ac-22).
//
//   ac-9  : a seat-count change triggers a Stripe subscription update with
//           proration_behavior=create_prorations (generating prorated items).
//   ac-22 : the seat change updates the subscription quantity immediately on
//           confirm, with a prorated preview fetched via /v1/invoices/upcoming
//           BEFORE confirm.
//
// Both functions do a preliminary GET /subscriptions/:id to find the item id,
// then act. The fetch mock therefore branches on URL + method: the subscription
// GET returns a one-item subscription, the seat-update POST / upcoming-invoice
// GET are captured for assertion.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { updateSubscriptionSeats, previewUpcomingInvoice } from "./stripe.js";

const AC_9 = "mindset-prod/memex-building-itself/specs/spec-171/acs/ac-9";
const AC_22 = "mindset-prod/memex-building-itself/specs/spec-171/acs/ac-22";

const SUB_ID = "sub_test_123";
const ITEM_ID = "si_test_abc";

interface Captured {
  url: string;
  method: string;
  body: URLSearchParams | null;
}

let calls: Captured[] = [];

function subscriptionResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: SUB_ID,
      object: "subscription",
      status: "active",
      items: { data: [{ id: ITEM_ID, price: { id: "price_x" }, quantity: 3 }] },
    }),
  } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
      calls.push({ url, method, body });

      // Preliminary subscription read (both functions do this first).
      if (url.includes(`/subscriptions/${SUB_ID}`) && method === "GET") {
        return subscriptionResponse();
      }
      // Upcoming-invoice preview (ac-22). The upcoming invoice carries BOTH the
      // proration adjustment (rest of this period) and the new period's recurring
      // line — previewUpcomingInvoice splits them so the UI never labels the sum
      // "billed today" (spec-171 verify defect).
      if (url.includes("/invoices/upcoming")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            amount_due: 7497,
            currency: "usd",
            lines: {
              data: [
                { amount: 2497, proration: true }, // proration for the rest of this period
                { amount: 5000, proration: false }, // new go-forward monthly total
              ],
            },
          }),
        } as unknown as Response;
      }
      // Seat-update POST (ac-9 / ac-22).
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: SUB_ID, object: "subscription" }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spec-171 ac-9 / ac-22: seat-count change updates the Stripe subscription", () => {
  it("updateSubscriptionSeats POSTs the new quantity with create_prorations", async () => {
    // ac-9: the update carries proration_behavior=create_prorations.
    tagAc(AC_9);
    // ac-22: the update sends the NEW quantity to Stripe immediately.
    tagAc(AC_22);

    await updateSubscriptionSeats(SUB_ID, 9);

    // It first read the subscription, then POSTed the change.
    const post = calls.find(
      (c) => c.method === "POST" && c.url.endsWith(`/subscriptions/${SUB_ID}`),
    );
    expect(post).toBeDefined();
    const body = post!.body!;
    // ac-9: prorated invoice items are generated.
    expect(body.get("proration_behavior")).toBe("create_prorations");
    // ac-22: the new seat count is the quantity sent, against the existing item.
    expect(body.get("items[0][id]")).toBe(ITEM_ID);
    expect(body.get("items[0][quantity]")).toBe("9");
  });
});

describe("spec-171 ac-22: prorated preview via /v1/invoices/upcoming before confirm", () => {
  it("previewUpcomingInvoice GETs /v1/invoices/upcoming with the proposed quantity", async () => {
    // ac-22: the prorated preview shown before confirm is fetched from
    // Stripe's /v1/invoices/upcoming endpoint.
    tagAc(AC_22);

    const result = await previewUpcomingInvoice("cus_abc", SUB_ID, 12);

    const previewCall = calls.find((c) => c.url.includes("/invoices/upcoming"));
    expect(previewCall).toBeDefined();
    // Hits the canonical Stripe upcoming-invoice endpoint.
    expect(previewCall!.url).toContain("https://api.stripe.com/v1/invoices/upcoming");
    // Previews against the existing item with the PROPOSED new quantity.
    expect(previewCall!.url).toContain(`subscription=${SUB_ID}`);
    expect(previewCall!.url).toContain("subscription_items%5B0%5D%5Bquantity%5D=12");
    // Surfaces the proration + go-forward recurring split for the confirm prompt
    // (not the conflated sum) so the UI can present each honestly.
    expect(result).toEqual({
      prorationAmount: 2497,
      recurringAmount: 5000,
      currency: "usd",
    });
  });
});
