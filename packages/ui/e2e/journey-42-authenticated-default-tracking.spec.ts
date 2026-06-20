// spec-326 (std-28) — authenticated users are tracked BY DEFAULT (legitimate
// interest, opt-out), extending spec-254's anonymous opt-in.
//
// This journey drives the real UI to prove the regime change end-to-end:
//   - The anonymous opt-in consent banner is NOT shown to an authenticated user,
//     and no consent choice is ever recorded (ac-1).
//   - With NO consent granted, navigating the app fires a /telemetry POST — capture
//     is on by default for the authenticated user (ac-1).
//   - The settings opt-out remains the right-to-object valve: toggling it off stops
//     capture and persists across a reload (ac-3).
//
// `seedConsent: false` is deliberate — we must start from a CLEAN slate (no recorded
// consent) to prove default-tracking, not a pre-seeded 'denied'. Path-based nav
// [per std-2]; seeded via the env-gated test surface (no raw SQL).

import {
  test,
  expect,
  tenantPath,
  DEV_EMAIL,
  setUserName,
  seedOrg,
  emitAcEvents,
} from "./helpers/index.js";

// Clean slate: do not pre-record a 'denied' choice. We are proving that an
// authenticated user is tracked WITHOUT ever consenting.
test.use({ seedConsent: false });

const AC = [
  "mindset-prod/memex-building-itself/specs/spec-326/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-326/acs/ac-3",
];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-42-authenticated-default-tracking.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

const isTelemetryPost = (req: { url(): string; method(): string }): boolean =>
  req.url().includes("/telemetry") && req.method() === "POST";

test("an authenticated user is tracked by default with no consent, and can still opt out", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");
  const slug = resources.slug("auth-track");
  const org = await seedOrg({ ownerEmail: DEV_EMAIL, slug, name: "Tracking Org" });

  // Land on the org's Specs board. The dev bootstrap authenticates dev@memex.ai and
  // persists the session token to localStorage.
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/specs"), {
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  // Reload so the persisted token is present at mount — the consent banner reads it
  // synchronously and suppresses itself for the authenticated visitor (deterministic,
  // no first-login flash to race).
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  // ac-1: the anonymous opt-in banner is NOT shown to an authenticated user, and no
  // consent choice was ever recorded (we never asked).
  await expect(page.getByTestId("visitor-consent")).toHaveCount(0);
  const consent = await page.evaluate(() =>
    window.localStorage.getItem("memex.telemetry.consent"),
  );
  expect(consent).toBeNull();

  // ac-1: navigating to a different route TEMPLATE fires a /telemetry POST — tracked
  // by default, despite no consent having been granted.
  const telemetryPost = page.waitForRequest(isTelemetryPost, { timeout: 15_000 });
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/standards"), {
    waitUntil: "commit",
  });
  await telemetryPost;

  // ac-3: the settings opt-out is still the right-to-object valve. Turn it off…
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/org?tab=settings"), {
    waitUntil: "commit",
  });
  const toggle = page.getByTestId("telemetry-toggle");
  await expect(toggle).toBeChecked({ timeout: 15_000 });
  await toggle.uncheck();
  await expect(page.getByText("Usage analytics off")).toBeVisible();

  // …and the choice persists across a reload (it gates capture for this browser).
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByTestId("telemetry-toggle")).not.toBeChecked({ timeout: 15_000 });

  // ac-3: once opted out, navigation no longer fires /telemetry — capture is off.
  let firedAfterOptOut = false;
  page.on("request", (req) => {
    if (isTelemetryPost(req)) firedAfterOptOut = true;
  });
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/specs"), {
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });
  // Allow the deferred (requestIdleCallback / setTimeout) route-change fire window to
  // elapse, then assert nothing was sent.
  await page.waitForTimeout(2_500);
  expect(firedAfterOptOut).toBe(false);
});
