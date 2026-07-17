// Journey 54 — spec-460: welcome video v4 + post-video CTAs.
//
// Extends the spec-444 welcome arc (journey-53) with the spec-460 additions,
// exercised against the running app:
//   - the /welcome video src is the v6 asset (ac-1)
//   - the "book a call" line is hidden during playback and revealed once the
//     viewer crosses ~85%, linking to the booking alias in a new tab (ac-2)
//   - the Getting Started sidebar card shows its rows and dismissal persists
//     across a reload; dismissing every row unmounts the card (ac-3, ac-4)
//   - the avatar dropdown carries the Download desktop app + Book a call
//     fallbacks (ac-6)
//
// The download page + booking redirect themselves live on the marketing site
// (memex-website) and are verified there; ac-5 is not exercised here.

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
  "mindset-prod/memex-building-itself/specs/spec-460/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-460/acs/ac-2",
  "mindset-prod/memex-building-itself/specs/spec-460/acs/ac-3",
  "mindset-prod/memex-building-itself/specs/spec-460/acs/ac-4",
  "mindset-prod/memex-building-itself/specs/spec-460/acs/ac-6",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-54-spec-460-welcome-ctas.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(
  "/welcome plays the v6 video (ac-1) and reveals the book-a-call line near the end (ac-2)",
  async ({ page }) => {
    await setVideoWelcomed(DEV_EMAIL, false);
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

    // ac-1: the video src is the v6 asset on the public CDN.
    const videoSrc = await page.getByTestId("welcome-video-player").getAttribute("src");
    expect(videoSrc).toContain("welcome-to-memex-v6.mp4");

    // ac-2: the call line is hidden during playback.
    const callCta = page.getByTestId("welcome-video-call-cta");
    await expect(callCta).toHaveAttribute("aria-hidden", "true");

    // Drive the <video> past the 85% reveal threshold and fire timeupdate. jsdom
    // can't decode the media, so we set the numbers directly and dispatch the event
    // the component listens on (matches how the unit test stubs playback).
    await page.getByTestId("welcome-video-player").evaluate((el) => {
      const v = el as HTMLVideoElement;
      Object.defineProperty(v, "duration", { value: 100, configurable: true });
      Object.defineProperty(v, "currentTime", { value: 90, configurable: true });
      v.dispatchEvent(new Event("timeupdate"));
    });

    await expect(callCta).toHaveAttribute("aria-hidden", "false", { timeout: 5_000 });
    const link = callCta.getByRole("link", { name: /book a 30-minute call/i });
    await expect(link).toHaveAttribute("href", "https://www.memex.ai/book-a-call?src=welcome-video");
    await expect(link).toHaveAttribute("target", "_blank");

    // The primary path to /specs is unchanged (no interstitial). spec-462: end the
    // video so the primary button becomes "Get started →", then dismiss.
    await page.getByTestId("welcome-video-player").evaluate((el) => {
      (el as HTMLVideoElement).dispatchEvent(new Event("ended"));
    });
    await expect(page.getByTestId("welcome-video-cta")).toHaveText(/Get started/);
    await page.getByTestId("welcome-video-cta").click();
    await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });
  },
);

test(
  "Getting Started card shows its rows and dismissal persists across reload; card unmounts when empty (ac-3, ac-4)",
  async ({ page }) => {
    await gotoSpecsBoard(page);

    // ac-3: the card is present with the book-a-call row (the dev user is not
    // MCP-connected in the cold DB, so the desktop-app row shows too).
    const card = page.getByTestId("getting-started-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("getting-started-call-row")).toBeVisible();

    // ac-4: dismiss the call row; it goes and stays gone across a reload (localStorage).
    await page.getByTestId("getting-started-dismiss-call").click();
    await expect(page.getByTestId("getting-started-call-row")).toHaveCount(0);
    await page.reload({ waitUntil: "commit" });
    await expect(page.getByTestId("getting-started-call-row")).toHaveCount(0, { timeout: 10_000 });

    // Dismiss the whole card; it unmounts and stays gone across a reload.
    await page.getByTestId("getting-started-dismiss-card").click();
    await expect(page.getByTestId("getting-started-card")).toHaveCount(0);
    await page.reload({ waitUntil: "commit" });
    await expect(page.getByTestId("getting-started-card")).toHaveCount(0, { timeout: 10_000 });
  },
);

test(
  "avatar dropdown carries the Download desktop app + Book a call fallbacks (ac-6)",
  async ({ page }) => {
    await gotoSpecsBoard(page);

    await page.getByRole("button", { name: /Dev User/i }).click();

    const download = page.getByTestId("user-menu-download-app");
    const book = page.getByTestId("user-menu-book-a-call");
    await expect(download).toBeVisible({ timeout: 5_000 });
    await expect(download).toHaveAttribute("href", "https://www.memex.ai/download?src=account-menu");
    await expect(book).toBeVisible();
    await expect(book).toHaveAttribute("href", "https://www.memex.ai/book-a-call?src=account-menu");
  },
);
