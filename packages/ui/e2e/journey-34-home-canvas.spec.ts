import {
  test,
  expect,
  bareUrl,
  emitAcEvents,
  ensureUser,
  setUserName,
  setIdentityConfirmed,
  DEV_EMAIL,
  DEV_NAME,
} from "./helpers/index.js";

// Journey 34 — the Home Canvas onboarding journey (spec-305).
//
//   ac-1 — Home is the top, user-level nav item (flat /home), and a brand-new user
//          lands on the welcome step (the universal Beat-1 cold open).
//   ac-2 — the identity step: confirm the SSO name + the developer/designer/PM triangle.
//   ac-4 — the journey SELF-ADVANCES once identity is confirmed (state-derived).

const AC1 = "mindset-prod/memex-building-itself/specs/spec-305/acs/ac-1";
const AC2 = "mindset-prod/memex-building-itself/specs/spec-305/acs/ac-2";
const AC4 = "mindset-prod/memex-building-itself/specs/spec-305/acs/ac-4";

const TITLE =
  "a brand-new user lands on the welcome step, then self-advances through the identity step";

test.afterEach(async ({}, testInfo) => {
  // Re-confirm identity so the shared dev user lands on its board for other journeys
  // (the un-confirm below would otherwise leave it stuck on onboarding).
  await setIdentityConfirmed(DEV_EMAIL, true);
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC1, AC2, AC4],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-34-home-canvas.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page }) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, false); // un-confirm → needsOnboarding → welcome

  await page.goto(bareUrl("/home"));

  // Home is the top, user-level destination (ac-1).
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible({ timeout: 15_000 });

  // A brand-new user lands on the welcome step: the universal Beat-1 cold open (ac-1).
  await expect(page.getByTestId("journey-step-welcome")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/vibe coding viable/)).toBeVisible();
  await page.getByTestId("journey-cta-primary").click(); // Get started → identity

  // The identity step: name confirm (pre-filled from SSO) + the role triangle (ac-2).
  await expect(page.getByTestId("journey-step-identity")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("role-triangle")).toBeVisible();
  await expect(page.getByTestId("identity-name")).toHaveValue(DEV_NAME);

  // Continue confirms identity → the journey self-advances off identity (ac-4); with no
  // agent connected yet, the next derived step is connect-agent (MCP-first).
  await page.getByTestId("identity-continue").click();
  await expect(page.getByTestId("journey-step-connect-agent")).toBeVisible({ timeout: 10_000 });
});
