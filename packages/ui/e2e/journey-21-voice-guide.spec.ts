import { test, expect, bareUrl, emitAcEvents } from "./helpers/index.js";

// Journey 21 — voice guide session surface + lifecycle (spec-190 t-9).
//
// SCOPE: the voice affordance, the session lifecycle (start → pill → mute → end),
// and that an active session never blocks normal app use. The spoken turn itself
// (mic → STT → graph → TTS) is NOT driven here — it can't be made deterministic in
// a headless browser (the Silero VAD needs real speech), and it's covered by the
// unit/integration suites. This journey is the std-28 gate for the user-facing
// surface, and emits the two user-facing scope ACs (ac-1, ac-5).
//
// Voice runs against the deterministic fake provider (the e2e server sets
// MEMEX_ELEVENLABS_FAKE=1 so isVoiceConfigured() is true), with a fake mic device
// and an auto-accepted permission prompt (launch flags + granted permission below).

test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone"],
});

const AC1 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-1";
const AC5 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-5";

// Emit on pass AND fail per the ac-emission discipline (skipped emits nothing).
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC1, AC5],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-21-voice-guide.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("voice affordance is in-view on a registered screen, not in the global nav (ac-1)", async ({
  page,
}) => {
  await page.goto(bareUrl("/"));
  // Bare-domain landing auto-resolves to the dev user's personal-memex Specs board.
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  const affordance = page.locator("[data-voice-affordance]");
  await expect(affordance).toBeVisible();
  await expect(affordance).toBeEnabled();
  // ac-1: the affordance lives WITHIN the view, not in the global top/side nav.
  await expect(page.getByTestId("primary-nav").locator("[data-voice-affordance]")).toHaveCount(0);
});

test("start → pill → end, and an active session never blocks the app (ac-1 / ac-5)", async ({
  page,
}) => {
  await page.goto(bareUrl("/"));
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  // Start a session from the in-view affordance (this is what triggers the mic
  // permission prompt — auto-accepted via the fake-ui flag).
  await page.locator("[data-voice-affordance]").click();

  // The session pill appears (active) and replaces the affordance.
  const pill = page.locator("[data-voice-pill]");
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-voice-affordance]")).toHaveCount(0);

  // ac-5: the session never blocks normal use — the app still navigates with a
  // session active, and the pill persists across the route change (it's mounted at
  // the app shell, not the page).
  await page.getByTestId("primary-nav").getByRole("link", { name: "Standards" }).click();
  await expect(page).toHaveURL(/\/standards(\?|#|$)/);
  await expect(page.getByRole("heading", { name: "Standards" })).toBeVisible();
  await expect(pill).toBeVisible();

  // End the session (ac-5): the pill goes away and the in-view affordance returns
  // (standards-list is also a registered screen).
  await page.locator("[data-voice-end]").click();
  await expect(pill).toHaveCount(0);
  await expect(page.locator("[data-voice-affordance]")).toBeVisible();
});
