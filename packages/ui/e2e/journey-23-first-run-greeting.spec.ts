import { test, expect, gotoSpecsBoard, emitAcEvents, setOnboardingGreeted, DEV_EMAIL } from "./helpers/index.js";

// Journey 23 — first-run one-shot (spec-206).
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
// spec-474 removed the demo-walkthrough tour, so the former start_walkthrough
// test (spec-211) is gone with it.

test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone"],
});

const AC5 = "mindset-prod/memex-building-itself/specs/spec-206/acs/ac-5";
const AC14 = "mindset-prod/memex-building-itself/specs/spec-206/acs/ac-14";

// Which ACs each test proves (emit on pass AND fail per the discipline).
const ACS_BY_TITLE: Record<string, string[]> = {
  "a user who has already been greeted sees no dialogue and no auto session (ac-5 / ac-14)": [AC5, AC14],
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

  await gotoSpecsBoard(page);
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  // spec-393 (dec-3): replace the blind 3s sleep with a deterministic settle
  // signal. The idle in-view affordance is the POSITIVE proof the first-run
  // controller has finished its pass WITHOUT firing a greeting — wait for it to
  // render, then assert the negatives. Waiting on the real signal (not the clock)
  // keeps the no-dialogue / no-pill assertions meaningful: they can't pass simply
  // because nothing has mounted yet.
  await expect(page.locator("[data-voice-affordance]")).toBeVisible({ timeout: 15_000 });

  // ac-5 / ac-14: nothing first-run fires again — no dialogue card, no
  // auto-started session; just the idle in-view affordance (asserted above).
  await expect(page.getByTestId("specky-dialogue")).toHaveCount(0);
  await expect(page.locator("[data-voice-pill]")).toHaveCount(0);
});
