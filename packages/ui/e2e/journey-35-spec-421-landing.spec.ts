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

// Journey 35 — spec-421 dec-5: the first-load landing follows the user's onboarding
// progress, decided in the app router (RootRedirect) from a read-only journey-state read.
//
//   • A user who has NOT created their first spec lands on /home (the onboarding journey)
//     and can roam freely to the Specs board without being bounced back. This preserves
//     spec-312 ac-2 (incomplete journey ⇒ Home, not the empty board) and ac-3 (no wall).
//   • A user who HAS created their first spec (the hasSpec milestone — the "engaged"
//     signal) lands STRAIGHT on the Specs board, not /home. This is the new behaviour,
//     superseding spec-312 dec-1's universal /home (spec-421 ac-14 / ac-16).
//
// Tests run in declaration order in one worker: the no-spec case runs first (clean state),
// then the has-spec case seeds a spec and the afterEach deletes it — so neither leaks into
// the other or into sibling journeys (which navigate to the board explicitly via
// gotoSpecsBoard rather than relying on the `/` landing).

const S312_AC2 = "mindset-prod/memex-building-itself/specs/spec-312/acs/ac-2";
const S312_AC3 = "mindset-prod/memex-building-itself/specs/spec-312/acs/ac-3";
const S421_AC14 = "mindset-prod/memex-building-itself/specs/spec-421/acs/ac-14";
const S421_AC15 = "mindset-prod/memex-building-itself/specs/spec-421/acs/ac-15";
const S421_AC16 = "mindset-prod/memex-building-itself/specs/spec-421/acs/ac-16";

const FILE = "packages/ui/e2e/journey-35-spec-421-landing.spec.ts";

let seededSpecId: string | null = null;

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
  const acs = testInfo.title.includes("Specs board")
    ? [S421_AC14, S421_AC16]
    : testInfo.title.includes("demo spec")
      ? [S421_AC15]
      : [S312_AC2, S312_AC3];
  await emitAcEvents(acs, status, `${FILE}::${testInfo.title}`, testInfo.duration);
});

test("a user who hasn't created a spec lands on Home with the journey, and is free to roam", async ({
  page,
}) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  // Identity confirmed but NO spec yet — still getting started.
  await setIdentityConfirmed(DEV_EMAIL, true);

  // Land on `/` so RootRedirect makes the decision under test.
  await page.goto(bareUrl("/"));

  // ac-2 / spec-421: no spec ⇒ /home (the onboarding journey), not the Specs board.
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("home-canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("journey-layer")).toBeVisible({ timeout: 15_000 });

  // ac-3: the wall is gone — navigating to the Specs board is allowed, not bounced back.
  await page.getByTestId("primary-nav").getByRole("link", { name: "Specs" }).click();
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/home(\?|#|$)/);
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

test("a user whose only spec is a demo spec still lands on Home (demo specs don't count)", async ({
  page,
}) => {
  const userId = await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, true);

  // Seed a DEMO spec (isDemo=true) — the kind spec-178 auto-seeds into every new Memex.
  // It must NOT count toward the hasSpec milestone, so the user is still "getting started".
  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  if (!memex) throw new Error("dev personal memex not provisioned");
  const demo = await seedSpecInMemex({
    memexId: memex.memexId,
    title: "Demo spec (landing journey)",
    createdByUserId: userId,
    isDemo: true,
  });
  seededSpecId = demo.docId;

  await page.goto(bareUrl("/"));

  // spec-421 ac-15: a demo-only user has hasSpec=false ⇒ lands on /home, not the board.
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("home-canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/specs(\?|#|$)/);
});
