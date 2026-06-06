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
import { getPersonalMemexByEmail, DEV_EMAIL } from "./helpers/index.js";
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

test("globalSetup leaves dev@memex.ai named so a cold-DB journey lands on Specs, not Onboarding", async ({
  page,
}) => {
  // globalSetup provisioned the personal memex; it must resolve.
  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  expect(memex, "globalSetup should have provisioned dev@memex.ai's personal memex").not.toBeNull();

  // Bare origin → PostLoginRouter resolves the named dev user into its personal
  // memex's Specs board. A nameless user would render the Onboarding profile
  // screen instead; assert the Specs heading appears and the onboarding name
  // prompt does not.
  // waitUntil: "commit" — PostLoginRouter may client-redirect mid-load.
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
    timeout: 15_000,
  });
});
