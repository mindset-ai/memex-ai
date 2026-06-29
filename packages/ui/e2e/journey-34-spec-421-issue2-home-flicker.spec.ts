import {
  test,
  expect,
  bareUrl,
  emitAcEvents,
  ensureUser,
  setUserName,
  setIdentityConfirmed,
  seedSpecInMemex,
  getPersonalMemexByEmail,
  deleteDoc,
  DEV_EMAIL,
  DEV_NAME,
} from "./helpers/index.js";

// Journey 34b — spec-421 issue-2: the Home "Getting started" tracker no longer flickers on
// draw. Barrie's prescription (Slack 2026-06-27): the state was "only assessed when the page
// is drawn, so you get the old state first and then a redraw" → assess it BEFORE draw, as a
// quick read-only that is NOT stored. The app assesses journey-state once at landing
// (RootRedirect) and shares it in-memory; navigating to /home paints the tracker from that
// already-assessed state instead of re-assessing from null after draw.
//
// This journey proves it deterministically: warm the assessment by landing once, then make
// the journey-state read HANG, then navigate to /home client-side. The tracker must still
// appear at its correct state well within the hung read — which is only possible if it
// painted from the shared (before-draw) assessment, not a fresh after-draw fetch.
//
//   ac-25 (spec-421) — e2e: after the app has assessed journey-state, navigating to /home
//          shows the correct tracker immediately, with no transient empty/0% frame.
//   ac-21 (spec-421) — cross-surface confirmation the issue-2 flicker no longer reproduces.
const AC25 = "mindset-prod/memex-building-itself/specs/spec-421/acs/ac-25";
const AC21 = "mindset-prod/memex-building-itself/specs/spec-421/acs/ac-21";
const FILE = "packages/ui/e2e/journey-34-spec-421-issue2-home-flicker.spec.ts";

let seededSpecId: string | null = null;

const TITLE =
  "after assessing journey-state at landing, navigating to /home paints the tracker from the shared assessment (no flicker even if a fresh read hangs)";

test.afterEach(async ({}, testInfo) => {
  if (seededSpecId) {
    await deleteDoc(seededSpecId);
    seededSpecId = null;
  }
  await setIdentityConfirmed(DEV_EMAIL, true);
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC25, AC21],
    testInfo.status === "passed" ? "pass" : "fail",
    `${FILE}::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page }) => {
  const userId = await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, true);

  // A real (non-demo) spec → the user is engaged (hasSpec). RootRedirect will land them on
  // the Specs board, and the journey-state it reads warms the shared in-memory assessment.
  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  if (!memex) throw new Error("dev personal memex not provisioned");
  const spec = await seedSpecInMemex({
    memexId: memex.memexId,
    title: "First spec (issue-2 flicker journey)",
    createdByUserId: userId,
  });
  seededSpecId = spec.docId;

  // 1) Land at `/`: RootRedirect performs the ONE read-only journey-state assessment and,
  //    because the user is engaged, routes them to the Specs board. Waiting for /specs
  //    guarantees that read completed and the shared assessment is now warm.
  await page.goto(bareUrl("/"));
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });

  // 2) Now make any FRESH journey-state read hang. If the Home tracker depended on an
  //    after-draw fetch, it could only show a blank/old frame until this resolved.
  await page.route("**/api/me/journey-state*", async () => {
    // Never fulfilled within the test — simulates a slow read.
  });

  // 3) Navigate to /home CLIENT-SIDE (no full reload, so the in-memory assessment survives).
  await page.getByTestId("primary-nav").getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });

  // 4) The tracker paints from the shared assessment — promptly, despite the hung read —
  //    at the correct engaged state (the first-spec step ticked), never an empty/0% frame.
  await expect(page.getByTestId("journey-layer")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("journey-progress")).toBeVisible();
  await expect(page.getByTestId("journey-progress")).not.toHaveText("0% complete");
  await expect(page.getByTestId("journey-rail-node-create-first-spec")).toHaveAttribute(
    "data-attained",
    "true",
  );
});
