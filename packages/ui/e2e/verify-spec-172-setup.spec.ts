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
//      Onboarding unintentionally on a cold DB.
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

test("globalSetup leaves dev@memex.ai named so a cold-DB journey lands on Home, not Onboarding", async ({
  page,
}) => {
  // globalSetup provisioned the personal memex; it must resolve.
  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  expect(memex, "globalSetup should have provisioned dev@memex.ai's personal memex").not.toBeNull();

  // spec-421 dec-5: the first-load landing now routes by the hasSpec milestone. This spec
  // verifies the NAMING/onboarding gate (a named dev reaches the real app, not Onboarding),
  // so isolate that by clearing any spec an earlier journey leaked onto the shared dev user
  // — a brand-new named dev (no spec) lands on /home. (This test uses the raw `test`, not the
  // fixture, to avoid masking globalSetup's naming; clearing specs doesn't touch the name.)
  await clearUserSpecs(DEV_EMAIL);

  // Bare origin → spec-312: every authenticated user lands on /home (the universal
  // landing), where the Home Canvas renders. The point of ac-10 holds: a cold-DB
  // journey for the named dev user is NOT dropped into a blocking onboarding screen —
  // it reaches the real app surface (now /home, the Home Canvas) directly.
  // waitUntil: "commit" — RootRedirect may client-redirect mid-load.
  await page.goto("/", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("home-canvas")).toBeVisible({ timeout: 15_000 });
});
