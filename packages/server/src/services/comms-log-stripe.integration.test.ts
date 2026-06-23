import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { commsLog, users, orgs, namespaces } from "../db/schema.js";
import { recordStripeEmailComm } from "./comms-log.js";

// spec-341 t-4 — capturing Stripe-sent emails (dec-3). Stripe emails directly, so
// we record from the Stripe webhook by resolving customer → org billing-contact →
// user. ac-6: billing/Stripe emails are recorded. ac-12: recorded for the
// billing-contact user; skipped when none resolves. Best-effort.

const AC_RECORDED = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-6";
const AC_STRIPE = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-12";

const CUST_WITH_CONTACT = "cus_test_341_contact";
const CUST_NO_CONTACT = "cus_test_341_nocontact";
const BILLING_EMAIL = "billing-341@stripe-comms.example";

let userId: string;
const nsIds: string[] = [];

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: BILLING_EMAIL }).returning({ id: users.id });
  userId = u!.id;

  const [nsA] = await db.insert(namespaces).values({ slug: "stripe-comms-a", kind: "org" }).returning({ id: namespaces.id });
  const [nsB] = await db.insert(namespaces).values({ slug: "stripe-comms-b", kind: "org" }).returning({ id: namespaces.id });
  nsIds.push(nsA!.id, nsB!.id);

  await db.insert(orgs).values({
    namespaceId: nsA!.id,
    name: "Stripe Comms A",
    stripeCustomerId: CUST_WITH_CONTACT,
    billingContactEmail: BILLING_EMAIL,
  });
  await db.insert(orgs).values({
    namespaceId: nsB!.id,
    name: "Stripe Comms B",
    stripeCustomerId: CUST_NO_CONTACT,
    billingContactEmail: null,
  });
});

afterAll(async () => {
  if (nsIds.length) await db.delete(namespaces).where(eq(namespaces.id, nsIds[0]!)).catch(() => {});
  if (nsIds[1]) await db.delete(namespaces).where(eq(namespaces.id, nsIds[1]!)).catch(() => {});
  if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("spec-341 t-4: recordStripeEmailComm (ac-6/12)", () => {
  it("ac-6/ac-12: records a Stripe email for the billing-contact user, tagged Stripe-sourced", async () => {
    tagAc(AC_RECORDED);
    tagAc(AC_STRIPE);

    const row = await recordStripeEmailComm({
      customerId: CUST_WITH_CONTACT,
      subject: "Payment receipt",
      sourceRef: "stripe:in_test_1",
    });
    expect(row, "a customer with a billing contact is recorded").not.toBeNull();
    expect(row!.userId).toBe(userId);
    expect(row!.channel).toBe("email");
    expect(row!.type).toBe("transactional");
    expect(row!.subject).toBe("Payment receipt");
    expect(row!.sourceRef).toBe("stripe:in_test_1");
  });

  it("ac-12: skips when the Stripe customer is unknown", async () => {
    tagAc(AC_STRIPE);
    const row = await recordStripeEmailComm({ customerId: "cus_unknown_341", subject: "Payment receipt" });
    expect(row).toBeNull();
  });

  it("ac-12: skips when the org has no billing-contact email on file", async () => {
    tagAc(AC_STRIPE);
    const row = await recordStripeEmailComm({ customerId: CUST_NO_CONTACT, subject: "Payment receipt" });
    expect(row).toBeNull();
  });
});
