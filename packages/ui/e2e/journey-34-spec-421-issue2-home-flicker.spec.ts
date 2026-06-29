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

// Journey 34b — spec-421 issue-2: the Home "Getting started" tracker no longer flickers on
// draw. Navigating to /home, the tracker used to render in a pre-data state (the whole
// journey layer absent while journey-state was in flight) and then POP into existence once
// GET /api/me/journey-state resolved. The fix holds first paint behind a stable-height
// skeleton (Barrie's "assess read-only before draw"), so the real tracker swaps in at its
// true progress with no empty→populated pop and no transient 0% frame.
//
//   ac-25 (spec-421) — an e2e journey navigates to /home for a user with onboarding progress
//          and asserts the tracker shows the correct progress with no transient empty/0% frame
//          (the skeleton holds first paint until journey-state resolves).
//   ac-21 (spec-421) — cross-surface confirmation the issue-2 flicker no longer reproduces.
const AC25 = "mindset-prod/memex-building-itself/specs/spec-421/acs/ac-25";
const AC21 = "mindset-prod/memex-building-itself/specs/spec-421/acs/ac-21";

const TITLE =
  "navigating to /home holds first paint behind a skeleton (no empty/0% flash), then shows the correct tracker";

test.afterEach(async ({}, testInfo) => {
  // Re-confirm identity so the shared dev user lands on its board for other journeys.
  await setIdentityConfirmed(DEV_EMAIL, true);
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC25, AC21],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-34-spec-421-issue2-home-flicker.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page }) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  // Identity confirmed → the user has onboarding progress (past step 0): the tracker shows a
  // non-zero, multi-step rail (so a stale empty/0% frame would be plainly visible if it flashed).
  await setIdentityConfirmed(DEV_EMAIL, true);

  // Hold the journey-state response until we've checked the loading frame. This makes the
  // "no flicker" guarantee deterministic: while the read-only fetch is in flight, the page
  // must show the skeleton — never the real layer or a 0% progress value.
  let releaseJourneyState!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseJourneyState = resolve;
  });
  await page.route("**/api/me/journey-state*", async (route) => {
    await gate;
    await route.continue();
  });

  await page.goto(bareUrl("/home"));

  // FIRST PAINT (fetch still in flight): the skeleton holds the tracker's place. The real
  // journey layer is NOT mounted, and there is no transient "0% complete" progress frame.
  await expect(page.getByTestId("journey-layer-skeleton")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("journey-layer")).toHaveCount(0);
  await expect(page.getByTestId("journey-progress")).toHaveCount(0);

  // Release the read-only journey-state read → the real tracker swaps in at its true state.
  releaseJourneyState();

  // The real tracker is now shown: the 3-node rail, a non-zero progress, identity ✓ — and the
  // skeleton is gone. No empty→populated pop was ever visible.
  await expect(page.getByTestId("journey-rail")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("journey-layer-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("journey-progress")).not.toHaveText("0% complete");
  await expect(page.getByTestId("journey-rail-node-identity")).toHaveAttribute("data-attained", "true");
});
