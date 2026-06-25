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

// Journey 35 — spec-312: everyone lands on Home, and the onboarding wall is gone.
//
//   ac-2 — a user who has CONFIRMED identity but not finished onboarding, navigating to
//          `/`, lands on /home and is shown the onboarding journey (NOT the Specs board).
//          This is the exact "abandoned after one trivial click" bug spec-312 fixes:
//          under the old routing, identity-confirmed ⇒ needsOnboarding=false ⇒ the user
//          was sent to computeDefaultLanding (their empty Specs board) with no guidance.
//   ac-3 — the wall is gone: from Home the user can navigate to the Specs board and is
//          NOT force-redirected back to onboarding/Home.

const AC2 = "mindset-prod/memex-building-itself/specs/spec-312/acs/ac-2";
const AC3 = "mindset-prod/memex-building-itself/specs/spec-312/acs/ac-3";

const TITLE =
  "an identity-confirmed, not-yet-onboarded user lands on Home with the journey, and is free to roam";

test.afterEach(async ({}, testInfo) => {
  // Leave the shared dev user identity-confirmed so other journeys land on their board.
  await setIdentityConfirmed(DEV_EMAIL, true);
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC2, AC3],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-35-spec-312-home-landing.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page }) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  // Identity CONFIRMED (needsOnboarding=false) but onboarding NOT finished — the case
  // the old routing abandoned on the Specs board.
  await setIdentityConfirmed(DEV_EMAIL, true);

  // Land on `/` (the root) so RootRedirect makes the routing decision under test.
  await page.goto(bareUrl("/"));

  // ac-2: RootRedirect sends them to /home (the universal landing), not the Specs board.
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("home-canvas")).toBeVisible({ timeout: 15_000 });
  // The onboarding journey is shown on Home: the "Getting started on Memex" journey layer
  // is the unmistakable signal we're on the journey, not Specs. (spec-372 t-6 hid the
  // "Your Journeys" pearls — formerly the signal here — so we key on the journey layer,
  // which still renders for a not-yet-graduated user.)
  await expect(page.getByTestId("journey-layer")).toBeVisible({ timeout: 15_000 });

  // ac-3: the wall is gone — navigating to the Specs board is allowed and is NOT bounced
  // back to Home/onboarding. Scope to the primary nav (the home-of-value surface also has
  // an "Open your Specs board" link, so an unscoped name match is ambiguous).
  await page.getByTestId("primary-nav").getByRole("link", { name: "Specs" }).click();
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/home(\?|#|$)/);
});
