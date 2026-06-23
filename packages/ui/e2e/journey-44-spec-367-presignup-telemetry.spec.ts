// std-28 PR-gate journey for the stateless pre-signup telemetry (spec-367).
//
// The anonymous consent popup is gone (spec-367 reversed spec-254 dec-4). A genuinely
// anonymous visitor reaching the signup form produces the funnel-head event
// (signup.form_viewed) via the flat /api/telemetry ingress with NO consent banner ever
// shown and NO durable cookie set — pure identifier-less volume under legitimate
// interest. Path-based nav [per std-2]; env-gated test surface only (no raw SQL).

import { test, expect, bareUrl, emitAcEvents } from "./helpers/index.js";

const AC = [
  "mindset-prod/memex-building-itself/specs/spec-367/acs/ac-6", // popup gone, no banner
  "mindset-prod/memex-building-itself/specs/spec-367/acs/ac-2", // events fire, no cookie
];

// Stay logged out. The dev harness auto-authenticates dev@memex.ai, so set the
// dev-logout sentinel before every load (addInitScript re-runs on each navigation) to
// exercise the genuinely-anonymous pre-signup path.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.sessionStorage.setItem("memex-dev-logout", "1");
    } catch {
      // sessionStorage unavailable — the bootstrap would auth and the assertions
      // below (anonymous signup screen) would then surface it as a failure.
    }
  });
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-44-spec-367-presignup-telemetry.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

async function visitorCookie(page: import("@playwright/test").Page): Promise<string | undefined> {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "memex_vid")?.value;
}

test("an anonymous visitor at the signup form fires signup.form_viewed — no banner, no cookie", async ({
  page,
}) => {
  // Arm the funnel-head capture before navigating: the flat, tenant-less ingress POST.
  const formViewed = page.waitForRequest(
    (req) => {
      if (req.method() !== "POST" || !req.url().includes("/api/telemetry")) return false;
      try {
        return JSON.parse(req.postData() ?? "{}").name === "signup.form_viewed";
      } catch {
        return false;
      }
    },
    { timeout: 20_000 },
  );

  await page.goto(bareUrl("/"));

  // ac-6: the anonymous consent banner is gone — it is never shown to anyone.
  await expect(page.getByTestId("visitor-consent")).toHaveCount(0);

  // Drive enter-email → Continue → the create-password (signup) view for a fresh email.
  const email = `presignup-${Date.now()}@example.com`;
  const input = page.getByPlaceholder("you@company.com");
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.fill(email);
  await page.getByRole("button", { name: /continue/i }).click();

  // The signup form shown → signup.form_viewed fired via the flat ingress (no tenant).
  await expect(page.getByRole("heading", { name: /^sign up$/i })).toBeVisible({ timeout: 15_000 });
  await formViewed;

  // ac-2: no durable identifier was minted — there is no memex_vid cookie.
  expect(await visitorCookie(page)).toBeUndefined();
});
