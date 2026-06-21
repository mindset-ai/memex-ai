import {
  test,
  expect,
  bareUrl,
  DEV_EMAIL,
  setUserName,
  seedOrg,
  emitAcEvents,
} from "./helpers/index.js";

// Journey 42 — spec-171 hosted upgrade flow, in-app up to the Stripe Checkout
// redirect (t-22, std-28 gate).
//
// SCOPE (deliberately bounded): the payment step delegates to EXTERNAL,
// Stripe-hosted Checkout (spec-171 dec-38 / ac-33). A deterministic PR-gate
// journey must NOT drive Stripe's page or hit the real Stripe API, so this
// journey covers OUR in-app flow up to — and including the attempt to perform —
// the redirect:
//   • plan-select renders the two HOSTED plans (Premium + Hosted Enterprise) and
//     NO Self-Hosted card (removed in the spec-323 split);
//   • the seats screen renders seat input + monthly/annual toggle ("save 17%") +
//     the local-currency-at-checkout note (t-19);
//   • "Continue to payment" POSTs the right body to /orgs/current/subscription
//     and the app attempts to redirect the browser to the returned Stripe URL;
//   • ac-5: no card-number input / Stripe Elements iframe exists anywhere in OUR
//     flow — card entry is delegated to Stripe-hosted Checkout, never our server.
//
// The POST is intercepted (page.route, branched on method) so no real Stripe call
// is made, and the checkout.stripe.com navigation is aborted so the browser never
// actually leaves to Stripe. Stripe's own page + the server-side Checkout Session
// creation are covered by unit/integration suites (ac-33: 5 tests) and manual
// post-deploy smoke — out of scope here by design.
//
// Emits the two SCOPE ACs this UI journey genuinely exercises:
//   ac-5 — Stripe-hosted, no card data on our server (primary; the UI half).
//   ac-1 — the upgrade purchase journey (the in-app UI portion up to redirect).
// The Stripe-side completion of ac-1 (subscription active, org on tier) is proven
// by the webhook/service suites, not this browser journey.

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-171/acs/ac-${n}`;

const ACS = [AC(5), AC(1)];

const STRIPE_CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_journey42";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-42-spec-171-upgrade.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("hosted upgrade: pick Enterprise, set seats + annual, redirect to Stripe Checkout — no card on our side (ac-1 / ac-5)", async ({
  page,
  resources,
}) => {
  // ── seed a Cloud Free org with the dev user as administrator ──────────────
  await setUserName(DEV_EMAIL, "Dev User");
  const slug = resources.slug("upgrade-org");
  const org = await seedOrg({
    ownerEmail: DEV_EMAIL,
    slug,
    name: "Upgrade Journey Org",
  });

  // ── 1. plan select ────────────────────────────────────────────────────────
  // /upgrade is a FLAT route [per App.tsx PostLoginRouter] — registered at the top
  // level, NOT under /:ns/:mx. Navigating a tenant path /<ns>/<mx>/upgrade falls
  // through the tenant route tree to the catch-all and bounces to the Specs board,
  // so we navigate the BARE path. The seeded org still backs "current org" via the
  // session (best-effort) — and the POST is intercepted regardless, so the exact
  // org-current resolution is moot here.
  void org; // seeded for the admin-on-Cloud-Free precondition; nav is path-agnostic
  await page.goto(bareUrl("/upgrade"), { waitUntil: "commit" });

  await expect(
    page.getByRole("heading", { name: "Choose your plan" }),
  ).toBeVisible({ timeout: 15_000 });

  // Positive render first (so the absence assertion below can't pass vacuously):
  // exactly the two HOSTED plans render.
  await expect(page.getByRole("heading", { name: "Premium", level: 3 })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Hosted Enterprise", level: 3 }),
  ).toBeVisible();

  // ac-3 of the task: the Self-Hosted card was removed in the spec-323 split — it
  // must NOT be present anywhere on the plan-select surface.
  await expect(page.getByText(/Self-?Hosted/i)).toHaveCount(0);

  // ── 2. → seats screen (UpgradeSeats) ──────────────────────────────────────
  await page.getByRole("button", { name: "Upgrade to Enterprise" }).click();
  await expect(page).toHaveURL(/\/upgrade\/enterprise$/);

  await expect(
    page.getByRole("heading", { name: "Upgrade to Hosted Enterprise" }),
  ).toBeVisible({ timeout: 15_000 });

  // seat input present…
  const seatInput = page.getByLabel("Number of seats");
  await expect(seatInput).toBeVisible();

  // …monthly/annual toggle showing "save 17%"…
  await expect(page.getByText("save 17%")).toBeVisible();

  // …and the local-currency-at-checkout note (t-19).
  await expect(
    page.getByText(/billed in your local currency at checkout/i),
  ).toBeVisible();

  // ac-5 (the IN-APP half): no card-number input and no Stripe Elements iframe
  // exists anywhere in OUR flow — payment is delegated to Stripe-hosted Checkout.
  // Anchored behind the positive seat-input render above so it can't pass vacuously.
  await expect(page.locator('iframe[src*="stripe"]')).toHaveCount(0);
  await expect(page.locator('iframe[name*="__privateStripe"]')).toHaveCount(0);
  await expect(page.locator('input[name*="cardnumber"]')).toHaveCount(0);
  await expect(
    page.locator('input[autocomplete="cc-number"]'),
  ).toHaveCount(0);

  // ── 3. make the POST body deterministic: 5 seats, annual ──────────────────
  await seatInput.fill("5");
  await page.getByRole("radio", { name: /Annual/ }).check();
  await expect(page.getByText("5 seats · annual")).toBeVisible();

  // ── 4. intercept checkout — branch on method so the plan-select GET to the
  //       same path (fetchCurrentSubscription) is not clobbered ───────────────
  let capturedBody: unknown = null;
  await page.route("**/orgs/current/subscription", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      capturedBody = req.postDataJSON();
      // Fulfill 200 { url } — NO real Stripe API is hit.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: STRIPE_CHECKOUT_URL }),
      });
    } else {
      await route.continue();
    }
  });

  // Abort the browser's attempt to actually navigate to Stripe-hosted Checkout —
  // the redirect ATTEMPT is what we verify; we never leave the app to Stripe.
  await page.route(/checkout\.stripe\.com/, (route) => route.abort());

  // ── 5. Continue to payment → assert POST fired + redirect attempted ───────
  const stripeNav = page.waitForRequest(/checkout\.stripe\.com/, {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /Continue to payment/ }).click();

  // The app attempted to redirect the browser to the returned Stripe URL.
  const navReq = await stripeNav;
  expect(navReq.url()).toBe(STRIPE_CHECKOUT_URL);

  // The intercepted POST fired with the correct body (plan + seats + cycle) —
  // and the redirect-to-Stripe request firing IS the positive proof the SUCCESS
  // branch ran: handleContinue only calls window.location.assign(url) on success;
  // the error catch sets an alert and never touches checkout.stripe.com. (We don't
  // assert the transient "Redirecting…" button or the absence of an alert here —
  // both race the aborted top-level navigation, which is already tearing the page
  // down by the time waitForRequest resolves.)
  expect(capturedBody).toEqual({
    plan: "enterprise",
    seats: 5,
    billingCycle: "annual",
  });
});
