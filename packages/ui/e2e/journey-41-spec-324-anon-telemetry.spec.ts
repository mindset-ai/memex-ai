// std-28 PR-gate journey for the journey-step CTA telemetry (spec-324).
//
// spec-324 gives the bespoke onboarding-journey step components the same intent
// signal the generic shell steps already emit: clicking a step's primary CTA records
// home_canvas.cta_clicked (props.step + props.cta) via POST /api/me/journey-event.
// This journey proves that end-to-end in a real browser: land a brand-new user on the
// welcome step and assert the CTA click fires the event. The pre-auth funnel head
// (signup.form_viewed) is proven by the LoginScreen component test + the anon-ingress
// integration test; this journey covers the authenticated, in-canvas half. Path-based
// nav, env-gated test surface only.

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
  clearUserSpecs,
  DEV_EMAIL,
  DEV_NAME,
} from "./helpers/index.js";

const AC = ["mindset-prod/memex-building-itself/specs/spec-324/acs/ac-6"];

test.afterEach(async ({}, testInfo) => {
  // Re-confirm identity + drop the seeded spec so the shared dev user is spec-less again
  // (other journeys assume it) and lands on its board.
  await setIdentityConfirmed(DEV_EMAIL, true);
  await clearUserSpecs(DEV_EMAIL);
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-41-spec-324-anon-telemetry.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("clicking a journey step's CTA records home_canvas.cta_clicked", async ({ page }) => {
  const userId = await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, true);

  // hero-first (spec-470/473): a spec-less user's /home is now the import hero, and the
  // operator preview suppresses journey telemetry by design — so neither reaches a real
  // journey-step CTA event. We give the dev user a real (non-demo) spec so /home shows the
  // onboarding TRACKER (has-spec ⇒ not the hero). create-spec ("Connect to the Memex MCP")
  // is milestoned on MCP connection — NOT spec authorship — so a has-spec-but-MCP-unconnected
  // user is still parked full-width on it, and its primary CTA fires a real
  // home_canvas.cta_clicked. spec-324 ac-6 is preserved end-to-end, on the same create-spec step.
  await clearUserSpecs(DEV_EMAIL);
  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  if (!memex) throw new Error("journey-41: dev user has no personal memex");
  await seedSpecInMemex({
    memexId: memex.memexId,
    title: "Spec that lights hasSpec (journey-41)",
    createdByUserId: userId,
  });

  // Arm the assertion before the click: capture the journey-event POST for a 'cta'.
  // create-spec's primary CTA ("copy-explore-prompt") records home_canvas.cta_clicked
  // (step 'create-spec', cta 'copy_explore_prompt').
  const ctaEvent = page.waitForRequest(
    (req) => {
      if (req.method() !== "POST" || !req.url().includes("/api/me/journey-event")) return false;
      try {
        const body = JSON.parse(req.postData() ?? "{}");
        return body.action === "cta" && body.step === "create-spec";
      } catch {
        return false;
      }
    },
    { timeout: 20_000 },
  );

  await page.goto(bareUrl("/home"));

  // has-spec ⇒ the tracker shows (not the hero); the user is parked full-width on create-spec.
  await expect(page.getByTestId("getting-started-title")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("journey-step-create-spec")).toBeVisible({ timeout: 10_000 });

  // Click the primary CTA — it records home_canvas.cta_clicked.
  await page.getByTestId("copy-explore-prompt").click();

  const req = await ctaEvent;
  const body = JSON.parse(req.postData()!);
  expect(body.step).toBe("create-spec");
  expect(body.action).toBe("cta");
  expect(body.cta).toBe("copy_explore_prompt");
});
