import { test, expect, bareUrl, emitAcEvents, setOnboardingGreeted, DEV_EMAIL } from "./helpers/index.js";
import { seedWhatsNewEntry, clearWhatsNewEntries } from "./helpers/seed.js";
import { clearAnthropicQueue, queueAnthropicResponse } from "./helpers/anthropic-fake.js";

// Journey 23 — first-run one-shot + the walkthrough tour (spec-206 / spec-211).
//
// REWORKED by spec-242: the spec-206 voice AUTO-START is superseded (spec-242
// dec-2) — Specky now opens in TEXT via the docked dialogue card (journey-28 is
// that surface's std-28 gate), and the spoken greeting moves behind the explicit
// Turn on Mic press (spec-229). What survives of spec-206 here:
//   - the once-per-user one-shot: an already-greeted user is NOT greeted again
//     (ac-5 / ac-14) — now asserted as "no dialogue card, no auto session";
//   - spec-206 ac-1 ("auto-starts with no tap") and ac-17 ("no welcome modal")
//     are no longer emitted — the behaviours they named are superseded; their
//     last emissions go stale by design. spec-229 restores the spoken-greeting
//     journey behind Turn on Mic.
//
// The spec-211 walkthrough test now drives the tour from the What's New ear —
// the surviving seeded-session surface (session.start(openingContext) fires a
// proactive turn, exactly the seam the greeting used). The fake model returns
// start_walkthrough, which hands control to the spec-211 sequencer.

test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone"],
});

const AC5 = "mindset-prod/memex-building-itself/specs/spec-206/acs/ac-5";
const AC14 = "mindset-prod/memex-building-itself/specs/spec-206/acs/ac-14";
// spec-211: accepting the walkthrough opens the demo spec (the tour begins).
const AC211_1 = "mindset-prod/memex-building-itself/specs/spec-211/acs/ac-1";

// Which ACs each test proves (emit on pass AND fail per the discipline).
const ACS_BY_TITLE: Record<string, string[]> = {
  "a user who has already been greeted sees no dialogue and no auto session (ac-5 / ac-14)": [AC5, AC14],
  "a seeded proactive turn returning start_walkthrough starts the tour and opens the demo spec (spec-211 ac-1)": [AC211_1],
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

test("a user who has already been greeted sees no dialogue and no auto session (ac-5 / ac-14)", async ({
  page,
}) => {
  // Mark the dev user already-greeted (the once-per-user flag is set).
  await setOnboardingGreeted(DEV_EMAIL, true);

  await page.goto(bareUrl("/"));
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  // Give the first-run controller the same window journey-28 gives it.
  await page.waitForTimeout(3_000);

  // ac-5 / ac-14: nothing first-run fires again — no dialogue card, no
  // auto-started session; just the idle in-view affordance.
  await expect(page.getByTestId("specky-dialogue")).toHaveCount(0);
  await expect(page.locator("[data-voice-pill]")).toHaveCount(0);
  await expect(page.locator("[data-voice-affordance]")).toBeVisible();
});

test("a seeded proactive turn returning start_walkthrough starts the tour and opens the demo spec (spec-211 ac-1)", async ({
  page,
}) => {
  // Drive acceptance deterministically: the session's first (proactive) turn
  // returns the start_walkthrough tool — exactly what the model emits when the
  // user says "yes". That hands control to the client sequencer (spec-211),
  // which OPENS the draft demo spec before any narration.
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

  // Already-greeted so the first-run dialogue stays out of the way; the seeded
  // What's New ear is the surviving entry point that starts a session WITH an
  // opening context (the proactive-turn seam the old auto-greeting used).
  await setOnboardingGreeted(DEV_EMAIL, true);
  await clearWhatsNewEntries();
  await seedWhatsNewEntry({
    sourceSpecRef: "mindset-prod/memex-building-itself/specs/spec-journey23",
    sourceSpecHandle: "spec-journey23",
    title: "Walkthrough seed",
    whatText: "A seeded entry to start a guided session.",
    whyText: "Drives the proactive turn deterministically.",
  });

  try {
    await page.goto(bareUrl("/"));
    await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

    // Ribbon → popup → the entry's ear starts the seeded session.
    await page.getByTestId("whats-new-ribbon").click();
    await page.getByTestId("whats-new-ear-spec-journey23").click();

    // The proactive turn emits start_walkthrough → the sequencer opens the demo
    // spec's detail view (/specs/<handle>), leaving the board.
    await page.waitForURL(/\/specs\/spec-\d+(\?|#|$)/, { timeout: 20_000 });
    expect(page.url()).toMatch(/\/specs\/spec-\d+/);
  } finally {
    await clearWhatsNewEntries();
  }
});
