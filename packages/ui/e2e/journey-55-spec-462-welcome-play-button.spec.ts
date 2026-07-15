// Journey 55 — spec-462: the /welcome primary button is a three-state machine so
// it can never be mistaken for a skip.
//
// Before spec-462 the loud blue button and the quiet "Skip" link both dismissed —
// users read the loudest element as "play" and got silently skipped past the
// explainer. Now, exercised against the running app:
//   idle    → "▶ Play now"    (does NOT navigate)                         (ac-6)
//   playing → "Playing…"      (inert status, survives pause)             (ac-7)
//   ended   → "Get started →" (permanent dismiss → /specs)               (ac-8)
//   the "Skip" link is present in every state — idle, playing, ended —
//     and dismisses from each                                            (ac-9)
//   "Get started" never appears mid-playback, only after ended           (ac-8)
//   rewatch=1 is unchanged ("Back to Memex")                             (ac-10)
//
// Headless Chromium can't decode the CDN video, so playback state is driven by
// dispatching the media events the component listens on (same approach as
// journey-54's book-a-call reveal). ac-11 (telemetry) is covered by the unit test.

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
  "mindset-prod/memex-building-itself/specs/spec-462/acs/ac-6",
  "mindset-prod/memex-building-itself/specs/spec-462/acs/ac-7",
  "mindset-prod/memex-building-itself/specs/spec-462/acs/ac-8",
  "mindset-prod/memex-building-itself/specs/spec-462/acs/ac-9",
  "mindset-prod/memex-building-itself/specs/spec-462/acs/ac-10",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-55-spec-462-welcome-play-button.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(
  "primary button walks Play now → Playing… → Get started; idle does not navigate, ended dismisses (ac-6, ac-7, ac-8)",
  async ({ page }) => {
    await setVideoWelcomed(DEV_EMAIL, false);
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

    const cta = page.getByTestId("welcome-video-cta");
    const player = page.getByTestId("welcome-video-player");

    // ac-6: idle shows "▶ Play now" and no "Get started".
    await expect(cta).toHaveText(/Play now/);
    await expect(page.getByText("Get started →")).toHaveCount(0);

    // ac-6: clicking "Play now" must NOT navigate away (it plays the video).
    await cta.click();
    await expect(page).toHaveURL(/\/welcome/); // still on /welcome

    // ac-7: once playing, the button is an inert "Playing…" status (not a <button>).
    await player.evaluate((el) => (el as HTMLVideoElement).dispatchEvent(new Event("play")));
    await expect(cta).toHaveText(/Playing…/);
    await expect(cta).toHaveJSProperty("tagName", "DIV");

    // ac-8: only after the video ends does "Get started →" appear and dismiss → /specs.
    await player.evaluate((el) => (el as HTMLVideoElement).dispatchEvent(new Event("ended")));
    await expect(cta).toHaveText(/Get started/);
    await cta.click();
    await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });
  },
);

test(
  "the Skip link dismisses without watching, in the IDLE state (ac-9)",
  async ({ page }) => {
    await setVideoWelcomed(DEV_EMAIL, false);
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

    // ac-9: the Skip link is present even before playing, and dismisses → /specs.
    await expect(page.getByTestId("welcome-video-cta")).toHaveText(/Play now/);
    await page.getByTestId("welcome-video-skip").click();
    await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });
  },
);

test(
  "the Skip link dismisses from the PLAYING state — a mid-watch escape hatch (ac-9)",
  async ({ page }) => {
    await setVideoWelcomed(DEV_EMAIL, false);
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

    const cta = page.getByTestId("welcome-video-cta");
    const player = page.getByTestId("welcome-video-player");

    // Drive into the playing state, then confirm Skip is still offered and dismisses.
    await player.evaluate((el) => (el as HTMLVideoElement).dispatchEvent(new Event("play")));
    await expect(cta).toHaveText(/Playing…/);
    await page.getByTestId("welcome-video-skip").click();
    await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });
  },
);

test(
  "the Skip link dismisses from the ENDED state, beside Get started (ac-9)",
  async ({ page }) => {
    await setVideoWelcomed(DEV_EMAIL, false);
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

    const cta = page.getByTestId("welcome-video-cta");
    const player = page.getByTestId("welcome-video-player");

    await player.evaluate((el) => (el as HTMLVideoElement).dispatchEvent(new Event("play")));
    await player.evaluate((el) => (el as HTMLVideoElement).dispatchEvent(new Event("ended")));
    // ac-8: the ended state offers "Get started →" …
    await expect(cta).toHaveText(/Get started/);
    // ac-9: … and the Skip link is STILL present in the ended state and dismisses.
    await page.getByTestId("welcome-video-skip").click();
    await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });
  },
);

test(
  "'Playing…' survives a pause — it never flips back to a Play/Resume target (ac-7)",
  async ({ page }) => {
    await setVideoWelcomed(DEV_EMAIL, false);
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

    const cta = page.getByTestId("welcome-video-cta");
    const player = page.getByTestId("welcome-video-player");

    await player.evaluate((el) => (el as HTMLVideoElement).dispatchEvent(new Event("play")));
    await expect(cta).toHaveText(/Playing…/);

    // ac-7: a pause must NOT flip the status back to "Play now" / "Resume" — the
    // three-state machine only advances on `ended`, never rewinds on `pause`.
    await player.evaluate((el) => (el as HTMLVideoElement).dispatchEvent(new Event("pause")));
    await expect(cta).toHaveText(/Playing…/);
    await expect(page.getByText(/Resume/)).toHaveCount(0);
    await expect(cta).not.toHaveText(/Play now/);
    await expect(page).toHaveURL(/\/welcome/); // still on /welcome, not dismissed
  },
);

test(
  "'Get started' never appears mid-playback — only after the video ends (ac-8)",
  async ({ page }) => {
    await setVideoWelcomed(DEV_EMAIL, false);
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });

    const cta = page.getByTestId("welcome-video-cta");
    const player = page.getByTestId("welcome-video-player");

    // While playing, the forward "Get started →" move must not be offered yet …
    await player.evaluate((el) => (el as HTMLVideoElement).dispatchEvent(new Event("play")));
    await expect(cta).toHaveText(/Playing…/);
    await expect(page.getByText("Get started →")).toHaveCount(0);

    // … it appears only once the video has ended.
    await player.evaluate((el) => (el as HTMLVideoElement).dispatchEvent(new Event("ended")));
    await expect(cta).toHaveText(/Get started/);
  },
);

test(
  "rewatch mode is unchanged — Back to Memex, no Play-now machine (ac-10)",
  async ({ page }) => {
    // Stamp the dev user as already-welcomed so this test owns its precondition
    // and does not depend on a sibling test having dismissed the video first
    // (a prior test that leaves the user un-welcomed would otherwise route the
    // specs-board navigation back into /welcome). [per std-37 — test isolation]
    await setVideoWelcomed(DEV_EMAIL, true);
    await gotoSpecsBoard(page);
    await page.goto(bareUrl("/welcome?rewatch=1"), { waitUntil: "commit" });
    await expect(page.getByText("Let's dive in.")).toBeVisible({ timeout: 10_000 });

    // ac-10: rewatch keeps its "Back to Memex" button; the three-state cta is absent.
    await expect(page.getByTestId("welcome-video-back")).toHaveText(/Back to Memex/);
    await expect(page.getByTestId("welcome-video-cta")).toHaveCount(0);
    await expect(page.getByText("Play now")).toHaveCount(0);
  },
);
