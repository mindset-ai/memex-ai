// Journey 52 — spec-441: /onboarding name-capture gate for email/password signups.
//
// A fresh email/password user arrives with no display name. spec-441 restores the
// routing wall that sends them to /onboarding (name capture) before they can reach
// any authenticated surface. This journey walks the full arc: signup → email
// verification → intercepted at /onboarding → fills name → into the app (Specs board),
// with the Home Canvas reachable by explicit navigation.
//
// Covers:
//   ac-1 — nameless authenticated user is redirected to /onboarding, not into the app.
//   ac-2 — after submitting a name on /onboarding, the gate clears and the user reaches
//           the app. spec-461 retired the auto-/home landing, so they land on /specs.
//   ac-6 — the Home Canvas (reached by explicit nav post-461) shows two visible onboarding
//           steps; the identity step is absent per spec-433.
//
// Runs as a fresh per-test email — NOT dev@memex.ai — so the new session JWT proves
// the browser is authenticated as the signup user (spec-172 issue-1 fix applies here
// too: the dev bypass only fires on token-less requests).

import {
  test,
  expect,
  bareUrl,
  emitAcEvents,
  signupWithToken,
  dismissWelcomeVideo,
} from "./helpers/index.js";

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-441/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-441/acs/ac-2",
  "mindset-prod/memex-building-itself/specs/spec-441/acs/ac-6",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-52-spec-441-onboarding-gate.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(
  "email/password signup → intercepted at /onboarding (ac-1) → fills name → lands on /home with Home Canvas (ac-2, ac-6)",
  async ({ page, resources }) => {
    const email = resources.email("gate-newuser");
    const { verificationToken } = await signupWithToken({
      email,
      password: "correct-horse-battery-staple-9",
    });

    // Real verification — stamps email_verified_at and stores the session JWT
    // client-side (acceptSession). Postmark is never contacted.
    await page.goto(
      bareUrl(`/verify-email?token=${encodeURIComponent(verificationToken)}`),
      { waitUntil: "commit" },
    );
    await expect(
      page.getByRole("heading", { name: /You're all set!/ }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(email)).toBeVisible();

    // Continue — the user has no display name, so spec-441's RootRedirect gate
    // intercepts and redirects to /onboarding before /home renders.
    await page.getByRole("button", { name: /Continue to your Memex/ }).click();

    // ac-1: nameless authenticated user is sent to /onboarding, not /home.
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
    await expect(page.getByText("What's your name?")).toBeVisible({
      timeout: 10_000,
    });

    // Fill in a display name and submit.
    await page.getByPlaceholder("Your display name").fill("Gate User");
    await page.getByRole("button", { name: /^Continue$/ }).click();

    // spec-444: after name capture, the welcome video gate fires for new users.
    // Dismiss it so we can verify the downstream landing (ac-2).
    await dismissWelcomeVideo(page);

    // ac-2: after submitting the name (and dismissing the welcome video), the name gate
    // is satisfied and the user reaches the real app. spec-461 retired the automatic
    // /home landing, so a fresh user now lands on their Specs board (not Home).
    await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });

    // ac-6: the Home Canvas still renders its onboarding steps — reachable now by explicit
    // navigation (spec-461: Home is a destination you click to, not an auto-landing).
    // getting-started-title + create-spec step visible; identity step absent (spec-433).
    await page.goto(bareUrl("/home"));
    await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
    await expect(page.getByTestId("getting-started-title")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("journey-step-create-spec")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("journey-step-identity")).not.toBeVisible();
  },
);
