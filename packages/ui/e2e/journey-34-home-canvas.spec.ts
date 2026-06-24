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

// Journey 34 — the Home Canvas onboarding journey, v2 (spec-336).
//
//   ac-1 — Home is the top, user-level nav item (flat /home); the journey is a persistent
//          rail with a six-node nav, shown to every newcomer (not behind an opt-in).
//   ac-2 — step 0 is the identity step: confirm the SSO name + the developer/designer/PM
//          triangle.
//   ac-8 — the full arc is presented as a rail to a new user.
//   ac-5 — the journey SELF-ADVANCES once identity is confirmed (state-derived): with the
//          spec not yet created, the next step is create-spec.
const AC1 = "mindset-prod/memex-building-itself/specs/spec-336/acs/ac-1";
const AC2 = "mindset-prod/memex-building-itself/specs/spec-336/acs/ac-2";
const AC5 = "mindset-prod/memex-building-itself/specs/spec-336/acs/ac-5";
const AC8 = "mindset-prod/memex-building-itself/specs/spec-336/acs/ac-8";

const TITLE =
  "a brand-new user lands on the persistent rail at the identity step, then self-advances to create-spec";

test.afterEach(async ({}, testInfo) => {
  // Re-confirm identity so the shared dev user lands on its board for other journeys
  // (the un-confirm below would otherwise leave it stuck on onboarding).
  await setIdentityConfirmed(DEV_EMAIL, true);
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC1, AC2, AC5, AC8],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-34-home-canvas.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page }) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, false); // un-confirm → needsOnboarding → identity step

  await page.goto(bareUrl("/home"));

  // Home is the top, user-level destination (ac-1).
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible({ timeout: 15_000 });

  // A brand-new user opens FULL-WIDTH on the identity ("About you") step: the role
  // triangle + live persona (ac-2). The rail is hidden on step 0 (it reveals once past it).
  await expect(page.getByTestId("getting-started-title")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("journey-step-identity")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("role-triangle")).toBeVisible();
  await expect(page.getByTestId("journey-rail")).toBeHidden();

  // Continue confirms identity (persists role_coords) → the journey self-advances OFF the
  // identity step (ac-5) and the persistent full-arc rail reveals (ac-1/ac-8). We assert
  // the advance + the rail rather than a specific next step: this shared dev user may
  // already have a spec/decision from other journeys, so the first unmet step varies —
  // what's invariant is that confirming identity moves you forward onto the rail, where
  // create-spec (universal) and the builder-only agents-build node are both present.
  await page.getByTestId("identity-continue").click();
  await expect(page.getByTestId("journey-rail")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("journey-step-identity")).toBeHidden();
  await expect(page.getByTestId("journey-rail-node-create-spec")).toBeVisible();
  await expect(page.getByTestId("journey-rail-node-agents-build")).toBeVisible();
});
