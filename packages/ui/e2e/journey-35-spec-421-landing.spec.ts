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

// Journey 35 — spec-461: the first-load landing is always the Specs board, decided in the
// app router (RootRedirect). spec-461 retired the automatic /home landing that spec-421
// dec-5 introduced for not-yet-engaged users; Home is now reachable ONLY by explicit nav.
//
//   • A user who has NOT created their first spec lands on their Specs board (spec-461),
//     and Home remains reachable by clicking the sidebar Home link.
//   • A user who HAS created their first spec also lands on the Specs board — unchanged
//     (spec-421 ac-14 / ac-16's surviving clause: engaged ⇒ board, never /home).
//
// (spec-461 supersedes spec-312 ac-2 / spec-421 ac-15 — the old "no spec ⇒ /home" landing.
// The hasSpec attribution invariant that ac-15 rode on — demo/starter specs don't count —
// is proven in journey-51-spec-426-variant-b and journey-state.ts units.)
//
// Tests run in declaration order in one worker: the no-spec case runs first (clean state),
// then the has-spec case seeds a spec and the afterEach deletes it — so neither leaks into
// the other or into sibling journeys (which navigate to the board explicitly via
// gotoSpecsBoard rather than relying on the `/` landing).

const S461_AC1 = "mindset-prod/memex-building-itself/specs/spec-461/acs/ac-1";
const S461_AC2 = "mindset-prod/memex-building-itself/specs/spec-461/acs/ac-2";
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
    : [S461_AC1, S461_AC2];
  await emitAcEvents(acs, status, `${FILE}::${testInfo.title}`, testInfo.duration);
});

test("a user who hasn't created a spec lands on the Specs board, and Home stays reachable by nav", async ({
  page,
}) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  // Identity confirmed but NO spec yet — still getting started.
  await setIdentityConfirmed(DEV_EMAIL, true);

  // Land on `/` so RootRedirect makes the decision under test.
  await page.goto(bareUrl("/"));

  // spec-461 ac-1: no spec ⇒ the Specs board (NOT auto-landed on /home).
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/home(\?|#|$)/);

  // spec-461 ac-2: Home is still reachable — clicking the sidebar Home link renders it.
  await page.getByTestId("primary-nav").getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("home-canvas")).toBeVisible({ timeout: 15_000 });
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
