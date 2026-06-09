import { test, expect, bareUrl, emitAcEvents, setOnboardingGreeted, DEV_EMAIL } from "./helpers/index.js";
import { clearAnthropicQueue, queueAnthropicResponse } from "./helpers/anthropic-fake.js";

// Journey 23 — first-run Specky greeting (spec-206 t-5).
//
// SCOPE: the user-facing first-run surface — there is NO welcome modal (ac-17),
// the voice greeting auto-starts on a first session with no tap (ac-1), and a
// user who has already been greeted is NOT greeted again (ac-5 / ac-14). The
// spoken greeting itself (mic → STT → graph → TTS) is NOT driven here — it can't
// be made deterministic headless (same gate as journey-21); the opening-context
// content + stamp-on-active are covered by the unit suites (t-3). This journey is
// the std-28 gate for the surface and emits the user-facing scope ACs.
//
// Like journey-21, voice runs against the fake provider with a fake mic device and
// an auto-accepted permission prompt, so the auto-start can actually reach `active`.

test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone"],
});

const AC1 = "mindset-prod/memex-building-itself/specs/spec-206/acs/ac-1";
const AC5 = "mindset-prod/memex-building-itself/specs/spec-206/acs/ac-5";
const AC14 = "mindset-prod/memex-building-itself/specs/spec-206/acs/ac-14";
const AC17 = "mindset-prod/memex-building-itself/specs/spec-206/acs/ac-17";
// spec-211: accepting the walkthrough opens the demo spec (the tour begins).
const AC211_1 = "mindset-prod/memex-building-itself/specs/spec-211/acs/ac-1";

// Which ACs each test proves (emit on pass AND fail per the discipline).
const ACS_BY_TITLE: Record<string, string[]> = {
  "first session auto-starts the greeting with no tap, and no welcome modal (ac-1 / ac-17)": [AC1, AC17],
  "a user who has already been greeted is not greeted again (ac-5 / ac-14)": [AC5, AC14],
  "accepting the walkthrough starts the guided tour and opens the demo spec (spec-211 ac-1)": [AC211_1],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const acs = ACS_BY_TITLE[testInfo.title] ?? [];
  if (acs.length === 0) return;
  await emitAcEvents(
    acs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-23-first-run-greeting.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("first session auto-starts the greeting with no tap, and no welcome modal (ac-1 / ac-17)", async ({
  page,
}) => {
  // Un-greet the dev user so this IS a first session (the fixture pre-stamped it).
  await setOnboardingGreeted(DEV_EMAIL, false);

  await page.goto(bareUrl("/"));
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  // ac-17: the first-run experience is voice-only — NO welcome modal/dialog.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // ac-1: Specky initiates the session ITSELF — the active-session pill appears
  // with no click on the affordance. (The pill is how an active session renders.)
  await expect(page.locator("[data-voice-pill]")).toBeVisible({ timeout: 15_000 });
});

test("a user who has already been greeted is not greeted again (ac-5 / ac-14)", async ({
  page,
}) => {
  // Mark the dev user already-greeted (the once-per-user flag is set).
  await setOnboardingGreeted(DEV_EMAIL, true);

  await page.goto(bareUrl("/"));
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  // Give the first-run controller the same window it had above to (not) auto-start.
  await page.waitForTimeout(3_000);

  // ac-5 / ac-14: no auto-greeting — the idle in-view affordance is shown, not an
  // auto-started session pill. (The user can still start one manually; it just
  // isn't forced on them again.)
  await expect(page.locator("[data-voice-pill]")).toHaveCount(0);
  await expect(page.locator("[data-voice-affordance]")).toBeVisible();
});

test("accepting the walkthrough starts the guided tour and opens the demo spec (spec-211 ac-1)", async ({
  page,
}) => {
  // Drive acceptance deterministically: the guide's first (proactive) turn returns
  // the start_walkthrough tool — exactly what it emits when the user says "yes".
  // That hands control to the client sequencer (spec-211), which OPENS the draft
  // demo spec before any narration. (The live voice→LLM→narration timing + the
  // per-phase board progression are unit-tested + verified live on INT.)
  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: [],
    content: [{ type: "tool_use", id: "toolu_sp211", name: "start_walkthrough", input: {} }],
    stopReason: "tool_use",
  });
  // Follow-up turn after the tool_result (the graph loops back to the model).
  await queueAnthropicResponse({
    textDeltas: ["Let's begin."],
    content: [{ type: "text", text: "Let's begin." }],
    stopReason: "end_turn",
  });

  await setOnboardingGreeted(DEV_EMAIL, false);
  await page.goto(bareUrl("/"));
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  // The greeting auto-starts → its opening turn emits start_walkthrough → the
  // sequencer opens the demo spec's detail view (/specs/<handle>), leaving the board.
  await page.waitForURL(/\/specs\/spec-\d+(\?|#|$)/, { timeout: 20_000 });
  expect(page.url()).toMatch(/\/specs\/spec-\d+/);
});
