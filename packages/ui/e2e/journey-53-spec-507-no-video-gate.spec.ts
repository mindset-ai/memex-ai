// Journey 53 — spec-507: the first-run video gate is gone.
//
// This journey replaces the three it retires (the old journey-53/54/55, which
// existed to prove the spec-444 gate WORKED). It proves the inverse, because the
// failure worth catching now is someone silently reinstating a gate:
//
//   1. a brand-new signup reaches the app without ever passing through /welcome
//      (the RootRedirect fast path + the ac-17 re-show both used to fire here);
//   2. the same user deep-links straight to a flat route and lands there — the
//      FlatShell gate was the quietest of the four and the easiest to reinstate
//      by accident;
//   3. the surviving opt-in path still works: the account menu's "Watch intro
//      video" entry reaches the player (std-34 — a menu entry must not promise a
//      surface the app can't show).
//
// Note the deliberate absence of setup: this journey does NOT pre-stamp
// video_welcomed_at or seed sessionStorage, because those suppressions (and the
// helpers that provided them) were deleted with the gate. A fresh signup here is
// exactly the user the gate used to intercept.
//
// Covers (verified via emitAcEvents at the end):
//   ac-1  — a new user's first authenticated surface is the app, not the video
//   ac-2  — no entry path redirects to /welcome (root + flat-route deep link)
//   ac-3  — the video is still reachable on purpose
//   ac-14 — the guard journey itself (both entry paths + the opt-in path)

import {
  test,
  expect,
  bareUrl,
  emitAcEvents,
  signupWithToken,
} from "./helpers/index.js";

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-507/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-507/acs/ac-2",
  "mindset-prod/memex-building-itself/specs/spec-507/acs/ac-3",
  // ac-5 (scope): at least one PR-gate journey actively proves a new user never
  // meets the video — this is that journey.
  "mindset-prod/memex-building-itself/specs/spec-507/acs/ac-5",
  "mindset-prod/memex-building-itself/specs/spec-507/acs/ac-14",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-53-spec-507-no-video-gate.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("a new user never meets the welcome video, and can still choose to watch it", async ({
  page,
  resources,
}) => {
  // Record every URL the browser visits, so "never went to /welcome" is proven over
  // the whole trail rather than sampled at the end — a redirect that bounced through
  // the video and back would pass a final-URL check.
  const visited: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) visited.push(frame.url());
  });

  const email = resources.email("no-video", "memex.ai");
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

  // ── 1. Signup → name capture → the app. The two RootRedirect gates used to fire
  //       in this window (fast path on !videoWelcomedAt, then the !hasSpec re-show).
  await page.getByRole("button", { name: /Continue to your Memex/ }).click();

  await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
  await expect(async () => {
    await page.getByPlaceholder("Your display name").fill("No Video User");
    await expect(page.getByRole("button", { name: /^Continue$/ })).toBeEnabled({
      timeout: 2_000,
    });
  }).toPass({ timeout: 15_000 });
  await page.getByRole("button", { name: /^Continue$/ }).click();

  // ac-1: the first authenticated surface is the real app. (The exact landing is
  // spec-502's business — Trails, or the featured demo when one is provisioned —
  // so assert the app shell, not a specific route.)
  await expect(page.getByTestId("primary-nav")).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/\/welcome/);

  // ── 2. The flat-route deep link — the FlatShell gate's territory. ────────────
  await page.goto(bareUrl("/settings/integrations"), { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/settings\/integrations/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/welcome/);

  // ac-2: nothing in the trail so far touched the video page.
  expect(
    visited.filter((u) => u.includes("/welcome")),
    `unexpected /welcome redirect in: ${visited.join(" → ")}`,
  ).toEqual([]);

  // ── 3. The opt-in path still resolves (dec-1's kept surface, std-34). ─────────
  // Two independent halves of the honest-CTA claim:
  //   (a) the account-menu entry exists and points at /welcome — assert it directly
  //       rather than by driving the popup, whose close re-render races the SPA Link
  //       navigation;
  //   (b) /welcome renders the player — proven by a real navigation to the route.
  await page.getByRole("button", { name: /No Video User/ }).click();
  const watchEntry = page.getByTestId("user-menu-watch-video");
  await expect(watchEntry).toBeVisible();
  await expect(watchEntry).toHaveAttribute("href", "/welcome");

  await page.goto(bareUrl("/welcome"), { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });
  // Assert on the heading (plain DOM text, always present when WelcomePage mounts)
  // rather than the <video> element — the video's src is a real external GCS asset
  // the cold e2e env may not fetch, leaving the element with zero dimensions.
  // `toBeAttached` (not `toBeVisible`) checks the player is in the DOM without
  // depending on that external load.
  await expect(page.getByRole("heading", { name: /Let's dive in/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("welcome-video-player")).toBeAttached();
  // ac-3: exactly one exit — the retired skip link and × close are gone.
  await expect(page.getByTestId("welcome-video-back")).toBeVisible();
  await expect(page.getByTestId("welcome-video-skip")).toHaveCount(0);
  await expect(page.getByTestId("welcome-video-close")).toHaveCount(0);

  // And leaving returns to the app rather than stamping a dismissal.
  await page.getByTestId("welcome-video-back").click();
  await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });
});
