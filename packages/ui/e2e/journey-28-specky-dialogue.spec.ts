import { test, expect, bareUrl, emitAcEvents, setOnboardingGreeted, DEV_EMAIL } from "./helpers/index.js";

// Journey 28 — first-run Specky dialogue (spec-242, std-28 gate).
//
// SCOPE: the two-page first-run sequence. Specky opens in TEXT (no cold mic
// popup): page 1 is the mic-priming card — Specky introduces herself with a
// "Turn on Mic" + "Not now" (the card is NOT a modal; the board stays live
// behind it). "Turn on Mic" fires getUserMedia on the press and starts the
// session; "Not now" skips voice. "Next" advances to page 2, the "get the most
// out of Memex AI" value panel; "Close" consumes the server-side one-shot, leaves
// the Specky avatar tappable, and the dialogue never re-shows.
//
// Mic permission is GRANTED in this context (fake device) so the Turn-on-Mic
// path can reach `active`. Crucially, nothing auto-starts on LOAD — the pill
// only appears AFTER the explicit Turn on Mic press, which is the proof that
// getUserMedia isn't fired on load.

// NB: we deliberately do NOT pre-grant `permissions: ["microphone"]`. The mic
// must read as not-yet-granted so the "Turn on Mic" button renders (it's hidden
// once granted — ac-16). The fake-UI flag still auto-accepts the real
// getUserMedia prompt when the button is pressed, so the session can reach
// `active` without a pre-grant.
test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-242/acs/ac-${n}`;

// Which ACs each test proves (emit on pass AND fail per the discipline).
const ACS_BY_TITLE: Record<string, string[]> = {
  "first run opens on the mic-priming page in text — no mic prompt on load, board stays live":
    [AC(1), AC(2), AC(14)],
  "Turn on Mic starts the session, then Next → value panel → Close consumes the one-shot":
    [AC(15), AC(18), AC(3), AC(4), AC(5)],
  "Not now skips voice and is no dead end; the value panel still shows":
    [AC(17), AC(6)],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const acs = ACS_BY_TITLE[testInfo.title] ?? [];
  if (acs.length === 0) return;
  await emitAcEvents(
    acs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-28-specky-dialogue.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("first run opens on the mic-priming page in text — no mic prompt on load, board stays live", async ({
  page,
}) => {
  await setOnboardingGreeted(DEV_EMAIL, false);

  await page.goto(bareUrl("/"));
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  // Page 1 — Specky introduces herself in text, with Turn on Mic + Not now (ac-14).
  const card = page.getByTestId("specky-dialogue");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Hi, I'm Specky");
  await expect(page.getByTestId("turn-on-mic")).toBeVisible();
  await expect(page.getByTestId("mic-not-now")).toBeVisible();

  // NOT a modal: no dialog role, and the board behind stays interactive — the
  // New Spec composer opens while the card is up (it has no role=dialog, so we
  // assert via its placeholder, as journey-26 does).
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "+ New Spec" }).click();
  await expect(page.getByPlaceholder(/Describe the spec/i)).toBeVisible();
  await page.keyboard.press("Escape");

  // No voice auto-started on load (ac-1): the active-session pill is absent until
  // an explicit Turn on Mic press.
  await page.waitForTimeout(2_000);
  await expect(page.locator("[data-voice-pill]")).toHaveCount(0);
});

test("Turn on Mic starts the session, then Next → value panel → Close consumes the one-shot", async ({
  page,
}) => {
  await setOnboardingGreeted(DEV_EMAIL, false);

  await page.goto(bareUrl("/"));
  const card = page.getByTestId("specky-dialogue");
  await expect(card).toBeVisible({ timeout: 15_000 });

  // Press Turn on Mic → getUserMedia fires (fake-granted) → session reaches
  // active → the pill appears (ac-15).
  await page.getByTestId("turn-on-mic").click();
  await expect(page.locator("[data-voice-pill]")).toBeVisible({ timeout: 15_000 });

  // Next advances to the value panel (ac-18 / ac-3 / ac-4).
  const footer = page.getByTestId("specky-dialogue-footer");
  await expect(footer).toHaveText("Next");
  await footer.click();
  await expect(card).toContainText("Here's how you get the most out of Memex AI");
  await expect(card).toContainText("1. Connect your coding agent");
  await expect(card).toContainText("If you write code, do this first.");
  await expect(card).toContainText("2. Walk through the demo spec");
  await expect(card).toContainText("3. Work with your team");
  await expect(card.locator('input[type="checkbox"]')).toHaveCount(0);

  // Close ends + stamps the one-shot (ac-18 / ac-5): a reload never re-shows.
  const closer = page.getByTestId("specky-dialogue-footer");
  await expect(closer).toHaveText("Close");
  await closer.click();
  await expect(card).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2_000);
  await expect(page.getByTestId("specky-dialogue")).toHaveCount(0);
});

test("Not now skips voice and is no dead end; the value panel still shows", async ({ page }) => {
  await setOnboardingGreeted(DEV_EMAIL, false);

  await page.goto(bareUrl("/"));
  const card = page.getByTestId("specky-dialogue");
  await expect(card).toBeVisible({ timeout: 15_000 });

  // Decline the mic → no voice session starts (no pill), and the buttons clear
  // (no nagging), but the dialogue is no dead end (ac-17 / ac-6).
  await page.getByTestId("mic-not-now").click();
  await page.waitForTimeout(2_000);
  await expect(page.locator("[data-voice-pill]")).toHaveCount(0);
  await expect(page.getByTestId("turn-on-mic")).toHaveCount(0);

  // Next still advances to the value panel — the reviewer (text-only) path.
  await page.getByTestId("specky-dialogue-footer").click();
  await expect(card).toContainText("Here's how you get the most out of Memex AI");

  // Closing leaves the Specky avatar available (no dead end).
  await page.getByTestId("specky-dialogue-footer").click();
  await expect(page.locator("[data-voice-affordance]")).toBeVisible();
});
