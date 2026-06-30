import { test, expect, emitAcEvents, bareUrl } from "./helpers/index.js";
import {
  signupWithToken,
  seedWhatsNewEntry,
  clearWhatsNewEntries,
} from "./helpers/seed.js";

// Journey 51 — What's New ribbon is suppressed for a brand-new user (spec-439).
//
// SCOPE: a fresh user whose account was created after an existing What's New
// entry should NOT see the ribbon or confetti on their very first sign-in.
// The suppressBefore mechanism (spec-439) seeds the dismissed-at localStorage
// marker from the user's createdAt, so all pre-existing entries look already-
// seen.
//
// Uses signupWithToken + /verify-email to authenticate as a genuinely fresh
// user (NOT dev@memex.ai, whose createdAt is ancient and suppressBefore would
// be far in the past).
//
// The feed is GLOBAL so we clear it before + after to avoid cross-journey
// leakage (each test gets a fresh browser context with no dismiss marker).

const AC1 = "mindset-prod/memex-building-itself/specs/spec-439/acs/ac-1";
const AC2 = "mindset-prod/memex-building-itself/specs/spec-439/acs/ac-2";

// A fixed past date well before any test user's createdAt.
const PAST_DATE = "2026-01-01T00:00:00.000Z";

test.beforeAll(async () => {
  await clearWhatsNewEntries();
  // Seed an entry backdated to January so it predates the fresh user we create.
  await seedWhatsNewEntry({
    sourceSpecRef: "mindset-prod/memex-building-itself/specs/spec-journey51",
    sourceSpecHandle: "spec-journey51",
    title: "A historic release",
    whatText: "Something that shipped before you existed.",
    whyText: "Should not be visible to a brand-new user.",
    publishedAt: PAST_DATE,
  });
});

test.afterAll(async () => {
  await clearWhatsNewEntries();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC1, AC2],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-51-whats-new-new-user.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(
  "brand-new user does not see the What's New ribbon or confetti on first sign-in (ac-1 / ac-2)",
  async ({ page, resources }) => {
    const email = resources.email("whats-new-newuser");
    resources.emails.push(email);

    const { verificationToken } = await signupWithToken({
      email,
      password: "correct-horse-battery-staple-spec439",
    });

    // Authenticate the browser as the fresh user by consuming the verification
    // token — this stores the session JWT client-side (same pattern as journey-19).
    await page.goto(
      bareUrl(`/verify-email?token=${encodeURIComponent(verificationToken)}`),
      { waitUntil: "commit" },
    );
    await expect(
      page.getByRole("heading", { name: /You're all set!/ }),
    ).toBeVisible({ timeout: 15_000 });

    // Navigate to the app. A fresh user lands on /home (onboarding canvas),
    // not /specs — so we wait for the /api/whats-new response directly rather
    // than a heading that only appears post-onboarding.
    const whatsNewDone = page.waitForResponse(
      (r) => r.url().includes("/api/whats-new") && r.status() === 200,
      { timeout: 15_000 },
    );
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await whatsNewDone;

    // Give React a tick to process the response and (if the fix were broken)
    // mount the ribbon.
    await page.waitForTimeout(500);

    // ac-1: ribbon must be absent.
    await expect(page.getByTestId("whats-new-ribbon")).not.toBeVisible();

    // ac-2: confetti must be absent.
    await expect(page.getByTestId("whats-new-confetti")).not.toBeVisible();
  },
);
