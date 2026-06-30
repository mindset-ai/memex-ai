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
  DEV_EMAIL,
  DEV_NAME,
} from "./helpers/index.js";

const AC = ["mindset-prod/memex-building-itself/specs/spec-324/acs/ac-6"];

test.afterEach(async ({}, testInfo) => {
  // Re-confirm identity so the shared dev user lands on its board for other journeys.
  await setIdentityConfirmed(DEV_EMAIL, true);
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-41-spec-324-anon-telemetry.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("clicking a journey step's CTA records home_canvas.cta_clicked", async ({ page }) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, false); // un-confirm → roleCoords=null → server returns 'identity' → clamped to create-spec

  // Arm the assertion before the click: capture the journey-event POST for a 'cta'.
  // spec-433: the identity step is hidden; the first visible step is create-spec.
  // Its primary CTA ("copy-explore-prompt") records home_canvas.cta_clicked
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

  // spec-433: a brand-new user lands on create-spec (not identity).
  await expect(page.getByTestId("journey-step-create-spec")).toBeVisible({ timeout: 15_000 });

  // Click the primary CTA — it records home_canvas.cta_clicked.
  await page.getByTestId("copy-explore-prompt").click();

  const req = await ctaEvent;
  const body = JSON.parse(req.postData()!);
  expect(body.step).toBe("create-spec");
  expect(body.action).toBe("cta");
  expect(body.cta).toBe("copy_explore_prompt");
});
