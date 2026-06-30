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

// Journey 34 — the Home Canvas onboarding journey, spec-433 (identity step removed).
//
//   ac-1  (spec-336) — Home is the top, user-level nav item (flat /home).
//   ac-1  (spec-433) — a brand-new user (no roleCoords) opens full-width on create-spec;
//          the server returns 'identity' but clampToVisible maps it forward to 'create-spec'
//          (FIRST_STEP_ID).
//   ac-2  (spec-433) — the identity step is absent from the rail and content panel.
//   ac-4  (spec-433) — showRail=false while on FIRST_STEP_ID (create-spec); the rail is
//          hidden until the user advances to create-first-spec.
//   ac-3  (spec-421) — the rail now has exactly 2 visible nodes (create-spec,
//          create-first-spec); identity is not a visible rail node.
const AC336_1 = "mindset-prod/memex-building-itself/specs/spec-336/acs/ac-1";
const AC433_1 = "mindset-prod/memex-building-itself/specs/spec-433/acs/ac-1";
const AC433_2 = "mindset-prod/memex-building-itself/specs/spec-433/acs/ac-2";
const AC433_4 = "mindset-prod/memex-building-itself/specs/spec-433/acs/ac-4";
const AC421_3 = "mindset-prod/memex-building-itself/specs/spec-421/acs/ac-3";

const TITLE =
  "a brand-new user lands full-width on create-spec (identity step removed by spec-433); rail hidden on FIRST_STEP_ID";

test.afterEach(async ({}, testInfo) => {
  // Re-confirm identity so the shared dev user lands on its board for other journeys.
  await setIdentityConfirmed(DEV_EMAIL, true);
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC336_1, AC433_1, AC433_2, AC433_4, AC421_3],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-34-home-canvas.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page }) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, false); // un-confirm → roleCoords=null → server returns 'identity'

  await page.goto(bareUrl("/home"));

  // Home is the top, user-level nav destination (ac-1 spec-336).
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible({ timeout: 15_000 });

  // spec-433: the identity step is removed. The server returns currentStepId='identity'
  // (roleCoords=null → identityConfirmed=false), but clampToVisible maps it forward
  // to 'create-spec' because identity (index 0) precedes the first visible step (index 1).
  // The user lands full-width on create-spec — no identity form, no role triangle.
  await expect(page.getByTestId("getting-started-title")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("journey-step-create-spec")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("journey-step-identity")).not.toBeVisible();

  // Rail is hidden while displayStepId === FIRST_STEP_ID ('create-spec').
  // It reveals once the user advances to create-first-spec (ac-4 spec-433, ac-3 spec-421).
  await expect(page.getByTestId("journey-rail")).not.toBeVisible();
});
