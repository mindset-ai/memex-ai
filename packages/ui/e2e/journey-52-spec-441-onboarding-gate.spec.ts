// Journey 52 — spec-441: /onboarding name-capture gate for email/password signups.
//
// A fresh email/password user arrives with no display name. spec-441 restores the
// routing wall that sends them to /onboarding (name capture) before they can reach
// any authenticated surface. This journey walks the full arc: signup → email
// verification → intercepted at /onboarding → fills name → into the app.
//
// Covers:
//   ac-1 — nameless authenticated user is redirected to /onboarding, not into the app.
//   ac-2 — after submitting a name on /onboarding, the gate clears and the user reaches
//           the app. spec-498: the universal landing is Trails (via the /home redirect).
//
// (ac-6 covered the Home Canvas onboarding tracker's steps; that surface is retired on
//  this branch — Trails is the default landing — so the ac-6 assertion is dropped. The
//  identity-step-removed-by-spec-433 clamp stays covered by the HomeCanvas/App units.)
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
  "email/password signup → intercepted at /onboarding (ac-1) → fills name → lands in the app on Trails (ac-2)",
  async ({ page, resources }) => {
    const email = resources.email("gate-newuser", "memex.ai");
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
    // intercepts and redirects to /onboarding before the app landing renders.
    await page.getByRole("button", { name: /Continue to your Memex/ }).click();

    // ac-1: nameless authenticated user is sent to /onboarding, not into the app.
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
    await expect(page.getByText("What's your name?")).toBeVisible({
      timeout: 10_000,
    });

    // Fill in a display name and submit. The onboarding form can REMOUNT while
    // boot-time queries settle (full-suite cold runs: the click log shows the
    // button resolving enabled, the element detaching, and the fresh mount
    // rendering disabled because the remount wiped the controlled input).
    // Fill-and-verify inside a retry loop so a remount re-fills instead of
    // leaving the click waiting forever on a disabled button.
    await expect(async () => {
      await page.getByPlaceholder("Your display name").fill("Gate User");
      await expect(page.getByRole("button", { name: /^Continue$/ })).toBeEnabled({
        timeout: 2_000,
      });
    }).toPass({ timeout: 15_000 });
    await page.getByRole("button", { name: /^Continue$/ }).click();

    // spec-444: after name capture, the welcome video gate fires for new users.
    // Dismiss it so we can verify the downstream landing (ac-2).
    await dismissWelcomeVideo(page);

    // ac-2: after submitting the name (and dismissing the welcome video), the name gate
    // is satisfied and the user reaches the real app. spec-498: the universal landing is
    // the personal-memex Trails (the /home canonical redirect forwards to /:ns/:mx/trails).
    await expect(page).toHaveURL(/\/trails(\?|#|$)/, { timeout: 15_000 });
    // The app shell is rendered (not the /onboarding gate) — the name gate has cleared.
    await expect(page.getByTestId("primary-nav")).toBeVisible({ timeout: 15_000 });
    await expect(page).not.toHaveURL(/\/onboarding/);
  },
);
