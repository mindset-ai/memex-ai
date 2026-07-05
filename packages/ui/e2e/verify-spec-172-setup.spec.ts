// spec-172 ac-10 — the globalSetup cold-DB posture, verified in a real browser.
//
// This spec uses the RAW @playwright/test `test` (not the spec-172 fixture),
// because the fixture itself re-asserts the dev user's name per test — using it
// would mask whether GLOBALSETUP did the naming. By the time any test runs,
// playwright.config.ts's globalSetup has already ensured dev@memex.ai exists
// WITH a display name (e2e/global-setup.ts). We prove two things:
//
//   1. the dev user resolves with a personal memex (globalSetup provisioned it),
//   2. navigating to the bare origin on this (named) dev user lands on the Specs
//      board — NOT the Onboarding profile screen — i.e. no journey lands in
//      Onboarding unintentionally on a cold DB. (spec-461: the Specs board is the
//      universal landing; the old auto-/home landing was retired.)
//
// The onboarding flow keeps its OWN explicit journey (t-7 lifecycle spine) that
// clears the name and walks the screen — this spec is the complementary "named
// by default" half of ac-10.

import { test, expect } from "@playwright/test";
import { getPersonalMemexByEmail, clearUserSpecs, DEV_EMAIL } from "./helpers/index.js";
import { emitAcEvents } from "./helpers/emit-ac.js";

const AC10 = ["mindset-prod/memex-building-itself/specs/spec-172/acs/ac-10"];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    AC10,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/verify-spec-172-setup.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

test("globalSetup leaves dev@memex.ai named so a cold-DB journey lands on the Specs board, not Onboarding", async ({
  page,
}) => {
  // globalSetup provisioned the personal memex; it must resolve.
  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  expect(memex, "globalSetup should have provisioned dev@memex.ai's personal memex").not.toBeNull();

  // spec-461: the first-load landing is always the Specs board. This spec verifies the
  // NAMING/onboarding gate (a named dev reaches the real app, not Onboarding), so isolate
  // that by clearing any spec an earlier journey leaked onto the shared dev user — a
  // brand-new named dev (no spec) still lands on /specs. (This test uses the raw `test`, not
  // the fixture, to avoid masking globalSetup's naming; clearing specs doesn't touch the name.)
  await clearUserSpecs(DEV_EMAIL);

  // spec-444: suppress the welcome-video scope gate (ac-17 re-shows for users with no spec)
  // so this test can isolate the onboarding naming gate independently. The gate is correct
  // behaviour, but it's not what ac-10 is testing — suppress it per-session.
  await page.addInitScript(() => {
    sessionStorage.setItem('welcomeVideoDismissed', '1');
  });

  // Bare origin → spec-461: every authenticated user lands on their Specs board (the
  // automatic /home landing was retired). The point of ac-10 holds unchanged: a cold-DB
  // journey for the named dev user is NOT dropped into a blocking onboarding screen —
  // it reaches the real app surface (the Specs board) directly.
  // waitUntil: "commit" — RootRedirect may client-redirect mid-load.
  await page.goto("/", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });
});
