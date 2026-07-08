import {
  test,
  expect,
  bareUrl,
  emitAcEvents,
  ensureUser,
  setUserName,
  setIdentityConfirmed,
  getPersonalMemexByEmail,
  seedSpecInMemex,
  deleteDoc,
  DEV_EMAIL,
  DEV_NAME,
} from "./helpers/index.js";

// Journey 35 — the first-load landing decided in the app router (RootRedirect), across the
// spec-461 → spec-470 dec-9 evolution:
//
//   • A CONFIRMED spec-less user AUTO-LANDS on /home — the build-prompt hero (spec-470
//     dec-9, which re-introduced the auto-Home landing for this cohort, superseding
//     spec-461 dec-1 for them). The full hero → create → graduate flow lives in
//     journey-60-spec-470-new-home; here we assert only the landing decision.
//   • A user who HAS created their first spec lands on their Specs board — unchanged
//     (spec-421 ac-14 / ac-16 + spec-461's surviving clause: engaged ⇒ board, never /home).
//
// (The hasSpec attribution invariant — demo/starter specs don't count — is proven in
// journey-51-spec-426-variant-b and journey-state.ts units.)
//
// Tests run in declaration order in one worker: the no-spec case runs first (clean state),
// then the has-spec case seeds a spec and the afterEach deletes it — so neither leaks into
// the other or into sibling journeys (which navigate to the board explicitly via
// gotoSpecsBoard rather than relying on the `/` landing).

const S470_AC13 = "mindset-prod/memex-building-itself/specs/spec-470/acs/ac-13";
const S421_AC14 = "mindset-prod/memex-building-itself/specs/spec-421/acs/ac-14";
const S421_AC16 = "mindset-prod/memex-building-itself/specs/spec-421/acs/ac-16";

const FILE = "packages/ui/e2e/journey-35-spec-421-landing.spec.ts";

let seededSpecId: string | null = null;

// spec-444 (ac-17): the welcome-video scope gate re-shows for users without a spec
// (landOnHome = true). Suppress it for all tests in this file so they can isolate
// the spec-421 landing logic independently.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('welcomeVideoDismissed', '1');
  });
});

test.afterEach(async ({}, testInfo) => {
  // Clean up any spec this test seeded, and leave the shared dev user identity-confirmed
  // so sibling journeys land on their board.
  if (seededSpecId) {
    await deleteDoc(seededSpecId);
    seededSpecId = null;
  }
  await setIdentityConfirmed(DEV_EMAIL, true);
  if (testInfo.status === "skipped") return;
  const status = testInfo.status === "passed" ? "pass" : "fail";
  const acs = testInfo.title.includes("has created their first spec")
    ? [S421_AC14, S421_AC16]
    : [S470_AC13];
  await emitAcEvents(acs, status, `${FILE}::${testInfo.title}`, testInfo.duration);
});

test("a user who hasn't created a spec auto-lands on /home (the build-prompt hero)", async ({
  page,
}) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  // Identity confirmed but NO spec yet — confirmed spec-less (the fixture baseline
  // clears specs before each test, so hasSpec is false here).
  await setIdentityConfirmed(DEV_EMAIL, true);

  // Land on `/` so RootRedirect makes the decision under test.
  await page.goto(bareUrl("/"));

  // spec-470 dec-9 (ac-13): a confirmed spec-less user auto-lands on /home, the
  // Lovable-style build-prompt hero — NOT the Specs board (reverses spec-461 dec-1
  // for this cohort).
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("build-prompt-hero")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("getting-started-title")).toHaveCount(0);
});

test("a user who has created their first spec lands on the Specs board, not Home", async ({
  page,
}) => {
  const userId = await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, true);

  // Seed a real (non-demo) spec authored by the dev user → the hasSpec milestone is met,
  // so the router should treat them as engaged.
  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  if (!memex) throw new Error("dev personal memex not provisioned");
  const spec = await seedSpecInMemex({
    memexId: memex.memexId,
    title: "First spec (landing journey)",
    createdByUserId: userId,
  });
  seededSpecId = spec.docId;

  await page.goto(bareUrl("/"));

  // spec-421 ac-14 / ac-16: engaged ⇒ straight to the Specs board, NOT /home.
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/home(\?|#|$)/);
});
