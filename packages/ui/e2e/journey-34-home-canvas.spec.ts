import {
  test,
  expect,
  bareUrl,
  emitAcEvents,
  ensureUser,
  setUserName,
  getPersonalMemexByEmail,
  seedSpecInMemex,
  deleteDoc,
  DEV_EMAIL,
  DEV_NAME,
} from "./helpers/index.js";

// Journey 34 — the Home Canvas onboarding journey (spec-303).
//
//   ac-1 — Home is the top, user-level nav item (a flat /home destination).
//   ac-2 — a brand-new user (no real spec; the handhold demo is excluded) lands on
//          the "MD files are dead" welcome step.
//   ac-4 — after the user creates a real spec, the canvas SELF-ADVANCES (the
//          position is derived from real state, dec-3) — here proven across a
//          reload, which re-derives rather than resetting anything.

const AC1 = "mindset-prod/memex-building-itself/specs/spec-303/acs/ac-1";
const AC2 = "mindset-prod/memex-building-itself/specs/spec-303/acs/ac-2";
const AC4 = "mindset-prod/memex-building-itself/specs/spec-303/acs/ac-4";

const TITLE =
  "a brand-new user lands on the Home Canvas welcome step, then self-advances after creating a spec";

let seededDocId: string | null = null;

test.afterEach(async ({}, testInfo) => {
  // Don't leak a real spec onto the shared dev user (it would break the welcome
  // precondition for re-runs and other journeys).
  if (seededDocId) {
    await deleteDoc(seededDocId);
    seededDocId = null;
  }
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC1, AC2, AC4],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-34-home-canvas.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page }) => {
  const devUserId = await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);

  // Home is the top, user-level destination (ac-1).
  await page.goto(bareUrl("/home"));
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible({ timeout: 15_000 });

  // A brand-new user sees the welcome step: the "MD files are dead" splash (ac-2).
  await expect(page.getByTestId("journey-step-welcome")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(".md files")).toBeVisible();
  await expect(page.getByRole("button", { name: /Create your first spec/ })).toBeVisible();

  // Create a real spec for this user → the journey self-advances on the next load.
  const personal = await getPersonalMemexByEmail(DEV_EMAIL);
  expect(personal).not.toBeNull();
  const seeded = await seedSpecInMemex({
    memexId: personal!.memexId,
    title: "My first spec",
    createdByUserId: devUserId,
  });
  seededDocId = seeded.docId;

  await page.goto(bareUrl("/home"));
  await expect(page.getByTestId("journey-step-first-decision")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Your spec is alive. Now make the call.")).toBeVisible();
});
