import {
  test,
  expect,
  tenantPath,
  DEV_EMAIL,
  setUserName,
  seedOrg,
  setOrgBilling,
  emitAcEvents,
} from "./helpers/index.js";

// Journey 43 — spec-171 ac-2: a Hosted Enterprise customer changes seat count
// via Settings > Org > Billing, sees the prorated charge preview BEFORE confirm,
// and the seat-update PATCH fires with the new quantity (std-28 gate).
//
// ac-2 (exact): "A Hosted Enterprise customer can add or remove seats via
// Settings > Org > Billing, with prorated charge/credit applied immediately and
// reflected in Stripe subscription."
//
// SCOPE (deliberately bounded — the in-app half): this browser journey proves
//   • the seat-change UI renders ONLY for a paid (enterprise) org — the seed put
//     the org on a real paid Stripe tier (stripeCustomerId + planTier), the same
//     gate orgs.ts uses; rendering it is non-vacuous proof the seed worked;
//   • changing the seat count and clicking "Change seats" calls the preview GET
//     and shows the user the PRORATED charge/credit in the confirm modal BEFORE
//     they commit;
//   • clicking Confirm fires the seat-update PATCH with the correct new seat count.
//
// The preview GET (/orgs/current/subscription/preview) and the seat-update PATCH
// (/orgs/current/subscription) are intercepted at the browser (page.route), so NO
// real Stripe call is made — the server's previewUpcomingInvoice /
// updateSubscriptionSeats Stripe calls (the "reflected in Stripe subscription"
// half of ac-2) are OUT of browser scope by design and covered server-side by
// packages/server/src/services/stripe-seats.test.ts. This mirrors journey-42's
// bounding of the Checkout redirect.
//
// Emits ac-2 — the in-app seat-change UI portion. The Stripe-side application of
// the proration is proven by the service suite above, not this browser journey.

const AC = ["mindset-prod/memex-building-itself/specs/spec-171/acs/ac-2"];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-43-spec-171-seat-change.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("hosted enterprise: change seats from Settings > Org > Billing — prorated preview shown, PATCH fires with new quantity (ac-2)", async ({
  page,
  resources,
}) => {
  // ── seed an enterprise (paid) org with the dev user as administrator ────────
  await setUserName(DEV_EMAIL, "Dev User");
  const slug = resources.slug("seat-change-org");
  const org = await seedOrg({
    ownerEmail: DEV_EMAIL,
    slug,
    name: "Seat Change Journey Org",
  });
  // Put it on a real PAID Stripe tier so BillingTab renders the seat-change
  // section. stripeCustomerId + planTier are BOTH required (orgs.ts resolves to
  // "free" otherwise); mint a unique customer id per run (table-unique constraint).
  await setOrgBilling({
    orgId: org.orgId,
    stripeCustomerId: `cus_test_${slug}`,
    planTier: "enterprise",
    seatsPurchased: 5,
    stripeSubscriptionId: `sub_test_${slug}`,
  });

  // ── intercept the seat APIs BEFORE navigating ──────────────────────────────
  // The preview lives on its OWN url (/subscription/preview) — fulfill a
  // deterministic fake upcoming-invoice proration (positive ⇒ charge today).
  await page.route("**/orgs/current/subscription/preview**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      // The upcoming invoice's two parts, split server-side (spec-171 verify):
      // the proration for the rest of this period + the new go-forward total.
      body: JSON.stringify({
        prorationAmount: 1234,
        recurringAmount: 5000,
        currency: "usd",
      }),
    });
  });

  // The seat-update PATCH and the initial fetchCurrentSubscription GET share the
  // SAME url (/orgs/current/subscription) — branch on method so the GET hits the
  // real server (BillingTab must render the paid tier; that render IS the seed
  // proof) and only the PATCH is faked. The base pattern has no trailing wildcard,
  // so /subscription/preview won't cross-match this route.
  let capturedBody: unknown = null;
  await page.route("**/orgs/current/subscription", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      capturedBody = req.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, seatsPurchased: 8 }),
      });
    } else {
      await route.continue();
    }
  });

  // ── navigate to Settings > Org > Billing (tenant-scoped) ────────────────────
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/org?tab=billing"), {
    waitUntil: "commit",
  });

  // ── the seat-change input renders — only paid orgs get it (non-vacuous) ─────
  await expect(
    page.getByRole("heading", { name: "Change seats" }),
  ).toBeVisible({ timeout: 15_000 });
  const seatInput = page.getByLabel("Number of seats");
  await expect(seatInput).toBeVisible();
  // Seeded at 5 — the "Change seats" button is disabled while the input equals
  // the purchased count, so we must type a DIFFERENT value to enable it.
  await expect(seatInput).toHaveValue("5");

  // ── change the seat count, trigger preview ──────────────────────────────────
  await seatInput.fill("8");
  await page.getByRole("button", { name: "Change seats" }).click();

  // ── the PRORATED preview is shown to the user BEFORE confirm ────────────────
  // formatCurrency divides by 100: proration 1234 ⇒ "$12.34", recurring 5000 ⇒
  // "$50.00". The modal shows BOTH parts honestly (spec-171 verify) — nothing is
  // "billed today". Anchored behind the seat-input render above so it can't pass
  // vacuously.
  await expect(
    page.getByRole("heading", { name: /Change seats from 5 to 8\?/ }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText("Prorated charge for the rest of this period"),
  ).toBeVisible();
  await expect(page.getByText("$12.34")).toBeVisible();
  await expect(page.getByText("New recurring total")).toBeVisible();
  await expect(page.getByText("$50.00/mo")).toBeVisible();
  await expect(page.getByText(/nothing is charged today/i)).toBeVisible();

  // ── confirm → assert the PATCH fired with the correct new seat count ────────
  await page.getByRole("button", { name: "Confirm" }).click();

  // The modal closes once the PATCH resolves — proof the success branch ran.
  await expect(
    page.getByRole("heading", { name: /Change seats from 5 to 8\?/ }),
  ).toBeHidden({ timeout: 15_000 });

  // The intercepted PATCH fired with the new seat count (body key is `seats`).
  // No real Stripe call was made — preview + PATCH were both fulfilled locally.
  expect(capturedBody).toEqual({ seats: 8 });
});
