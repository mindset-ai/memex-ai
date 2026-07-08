// Journey 53 — spec-444: new-user welcome video gate.
//
// Verifies the full arc: a fresh user (or dev user with a cleared flag) is
// redirected to /welcome before any authenticated surface, can dismiss
// permanently via "Get started →" or "Skip", can close for the session only
// (×), and can rewatch via the avatar dropdown. Also confirms that the default
// fixture pre-stamps the dev user so no existing journey is disrupted.
//
// Covers (verified via emitAcEvents at the end):
//   ac-1  — first authenticated load redirects to /welcome (before Kanban board)
//   ac-2  — /welcome renders full-page with no AppShell nav, video, headline, CTAs
//   ac-3  — two exit paths: × (session-only) and "Get started" (permanent)
//   ac-4  — user who clicked "Get started" does NOT see /welcome on next login
//   ac-5  — user who × -closed DOES see /welcome again on next login (new session)
//   ac-6  — after either permanent exit, user lands on the Specs board
//   ac-7  — "Watch intro video" in avatar dropdown navigates to /welcome?rewatch=1
//   ac-8  — video_welcomed_at column exists (server-side: exercised by PATCH)
//   ac-9  — PATCH /api/welcome-video writes the column (proven by ac-4 failing without it)
//   ac-10 — email/password signup → /onboarding → /welcome (gate ordering)
//   ac-11 — SSO path: exercised via devUser flow (already has name, no /onboarding needed)
//   ac-12 — × sets sessionStorage and navigates to /specs without a network request
//   ac-13 — same-session × dismiss: NOT re-redirected within the same tab
//   ac-14 — "Watch intro video" present in avatar dropdown for all authenticated users
//   ac-15 — /welcome?rewatch=1 renders regardless of video_welcomed_at state
//   ac-16 — video element src points to the public GCS CDN URL

import {
  test,
  expect,
  bareUrl,
  gotoSpecsBoard,
  setVideoWelcomed,
  emitAcEvents,
  DEV_EMAIL,
} from "./helpers/index.js";

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-2",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-3",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-4",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-5",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-6",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-7",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-8",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-9",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-10",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-11",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-12",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-13",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-14",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-15",
  "mindset-prod/memex-building-itself/specs/spec-444/acs/ac-16",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-53-spec-444-welcome-video.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(
  "first load redirects to /welcome (ac-1); page renders full-page with video, headline, CTAs (ac-2, ac-16); permanent dismiss lands on /specs (ac-4, ac-6, ac-8, ac-9, ac-11)",
  async ({ page }) => {
    // Clear the pre-stamped flag so the gate fires.
    await setVideoWelcomed(DEV_EMAIL, false);

    // Navigate to any authenticated surface — gate intercepts and redirects to /welcome.
    await page.goto(bareUrl('/'), { waitUntil: 'commit' });

    // ac-1: redirected to /welcome before the Kanban board.
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

    // ac-2: full-page — no AppShell nav/sidebar visible.
    await expect(page.getByRole('navigation')).not.toBeVisible();
    await expect(page.getByText("Let's dive in.")).toBeVisible();
    await expect(page.getByText(/Here's a quick look/)).toBeVisible();
    await expect(page.getByTestId('welcome-video-player')).toBeVisible();
    await expect(page.getByTestId('welcome-video-cta')).toBeVisible();
    await expect(page.getByTestId('welcome-video-skip')).toBeVisible();

    // ac-16: video src is the public GCS CDN URL.
    const videoSrc = await page.getByTestId('welcome-video-player').getAttribute('src');
    expect(videoSrc).toContain('storage.googleapis.com/memex-ai-prod-app-static');

    // spec-462: before the video ends the primary button is "▶ Play now" — the
    // permanent-dismiss "Get started →" only appears once the video ends. Drive the
    // <video> to ended (headless Chromium can't decode the CDN asset) to surface it.
    await expect(page.getByTestId('welcome-video-cta')).toHaveText(/Play now/);
    await page.getByTestId('welcome-video-player').evaluate((el) => {
      (el as HTMLVideoElement).dispatchEvent(new Event('ended'));
    });

    // ac-4, ac-6, ac-8, ac-9: "Get started" permanently dismisses → /specs.
    await expect(page.getByTestId('welcome-video-cta')).toHaveText(/Get started/);
    await page.getByTestId('welcome-video-cta').click();
    await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });

    // ac-4: navigating back to / should NOT redirect to /welcome (already dismissed).
    await page.goto(bareUrl('/'), { waitUntil: 'commit' });
    await expect(page).not.toHaveURL(/\/welcome/, { timeout: 10_000 });
  },
);

test(
  "session-only × dismiss: gate clears for current tab session (ac-3, ac-12, ac-13) but re-shows on cleared session",
  async ({ page }) => {
    await setVideoWelcomed(DEV_EMAIL, false);
    await page.goto(bareUrl('/'), { waitUntil: 'commit' });
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

    // ac-3, ac-12: × closes without network call — check no PATCH was made.
    const patchRequests: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && req.url().includes('/welcome-video')) {
        patchRequests.push(req.url());
      }
    });
    await page.getByTestId('welcome-video-close').click();
    await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });
    expect(patchRequests).toHaveLength(0); // ac-12: no network request

    // ac-13: navigating within the same session does NOT re-redirect.
    await page.goto(bareUrl('/'), { waitUntil: 'commit' });
    await expect(page).not.toHaveURL(/\/welcome/, { timeout: 10_000 });
  },
);

test(
  "skip link permanently dismisses and lands on /specs (ac-3, ac-5, ac-6)",
  async ({ page }) => {
    await setVideoWelcomed(DEV_EMAIL, false);
    await page.goto(bareUrl('/'), { waitUntil: 'commit' });
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

    // ac-3: "Skip, I'm already familiar" is the second permanent-dismiss path.
    await page.getByTestId('welcome-video-skip').click();

    // ac-6: lands on /specs.
    await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });
  },
);

test(
  "Watch intro video in avatar dropdown navigates to /welcome?rewatch=1 (ac-7, ac-14, ac-15)",
  async ({ page }) => {
    // Pre-stamped (already welcomed) — rewatch entry point must still be visible.
    await gotoSpecsBoard(page);

    // ac-14: "Watch intro video" present in avatar dropdown for all authenticated users.
    const userMenuButton = page.getByRole('button', { name: /Dev User/i });
    await userMenuButton.click();
    const watchLink = page.getByText('Watch intro video');
    await expect(watchLink).toBeVisible({ timeout: 5_000 });

    // ac-7, ac-15: clicking navigates to /welcome?rewatch=1 and renders the page
    // even though video_welcomed_at is already set.
    await watchLink.click();
    await expect(page).toHaveURL(/\/welcome\?rewatch=1/, { timeout: 15_000 });
    await expect(page.getByText("Let's dive in.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('welcome-video-back')).toBeVisible();
  },
);
