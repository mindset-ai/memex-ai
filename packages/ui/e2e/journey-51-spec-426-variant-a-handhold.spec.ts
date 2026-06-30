// Journey 51 (spec-426) — Variant A: a fresh signup pinned to the CONTROL arm
// (handhold_demo) gets spec-178's working handhold-demo walkthrough AND the standard
// onboarding landing.
//
// This is the std-28 / ac-16 surface for the experiment's control arm (spec-426 s-5,
// ac-2). The control arm IS spec-178's existing demo: five is_demo Specs seeded into
// the new personal memex, surfaced as a progressive-reveal walkthrough on the Specs
// board. Crucially, a demo-only user's first-load landing is /home — `hasSpec`
// deliberately EXCLUDES is_demo rows (journey-state.ts), so shouldLandOnHome() is true.
// That is the ESTABLISHED, deliberate behavior locked by spec-421 ac-15 / spec-211: the
// demo lives on the board to be discovered, it does NOT hijack the guidance-first Home
// landing. (An earlier spec-426 attempt to reroute demo-only users onto the board was a
// misdiagnosis that regressed spec-421 ac-15 and was reverted; if the demo is "broken"
// in some other way, that needs a concrete repro before a fix.)
//
// What this journey pins:
//   1. The demo walkthrough RENDERS and is NAVIGABLE on the Specs board: exactly one
//      demo card shows at a time (progressive reveal), with the DEMO badge and the
//      advance control; advancing walks the walkthrough to the next phase.
//   2. From the bare origin `/`, a control (demo-only) user LANDS on /home — spec-421
//      ac-15, unchanged. The control arm gives a fresh user spec-178's known-good
//      onboarding, exactly as before the experiment existed.
//
// ── EXPERIMENT-ARM TEST HOOK ──────────────────────────────────────────────────
// The default experiment ships INACTIVE (draft), so provisioning degrades every signup
// to control anyway; this journey still pins the control arm EXPLICITLY over the test
// surface (helpers/experiments.ts → `POST /api/__test__/seed-experiment-arm`) so it
// asserts the control behaviour deterministically rather than relying on the default.

import {
  test,
  expect,
  bareUrl,
  gotoSpecsBoard,
  signupWithToken,
  setIdentityConfirmed,
  emitAcEvents,
} from "./helpers/index.js";
import { seedExperimentArm } from "./helpers/experiments.js";

const S426_AC2 = "mindset-prod/memex-building-itself/specs/spec-426/acs/ac-2";
const S426_AC16 = "mindset-prod/memex-building-itself/specs/spec-426/acs/ac-16";

const FILE =
  "packages/ui/e2e/journey-51-spec-426-variant-a-handhold.spec.ts";

const TITLE =
  "Variant A (control): a fresh signup gets spec-178's working, navigable handhold-demo walkthrough on the board AND the standard /home landing (spec-421 ac-15)";

test.afterEach(async ({}, testInfo) => {
  // A skipped test (hook not yet mounted) emits nothing — spec-426's ACs stay
  // visibly unverified rather than silently passing (mirrors journey-39).
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [S426_AC2, S426_AC16],
    testInfo.status === "passed" ? "pass" : "fail",
    `${FILE}::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page, resources }) => {
  // ── Fresh signup [per std-13] → authenticate the browser AS the new user ─────
  // (Same seam as journey-19's lifecycle-spine signup leg: the raw verification
  // token comes from /signup-with-token, Postmark is never contacted, and
  // /verify-email stores the new user's session JWT — which wins over the dev
  // bypass, so the browser drives as this user, not dev@memex.ai.)
  const email = resources.email("v426a"); // resources.email() tracks it for cleanup
  const { verificationToken } = await signupWithToken({
    email,
    password: "correct-horse-battery-staple-A",
  });

  await page.goto(
    bareUrl(`/verify-email?token=${encodeURIComponent(verificationToken)}`),
    { waitUntil: "commit" },
  );
  await expect(
    page.getByRole("heading", { name: /You're all set!/ }),
  ).toBeVisible({ timeout: 15_000 });

  // Confirm identity so needsOnboarding clears (spec-305) and the first-load
  // landing decision is reached for real — the alternative is walking the
  // onboarding identity step in the UI (journey-19), unnecessary detail here.
  await setIdentityConfirmed(email, true);

  // ── Pin the CONTROL arm + seed the handhold demo deterministically ───────────
  // The experiment-arm test hook (POST /api/__test__/seed-experiment-arm) is now
  // mounted, so this runs for real — supersedes the auto assignment with an
  // operator pin to the control arm and re-seeds the handhold demo.
  await seedExperimentArm({ email, behaviour: "handhold_demo" });

  // ── 1. The walkthrough renders and is navigable on the Specs board ───────────
  // Assert on the board explicitly first, so this coverage holds regardless of the
  // landing fix below.
  await gotoSpecsBoard(page, email);

  // Progressive reveal (spec-178 dec-10): five demo specs are seeded, but exactly
  // ONE shows at a time — the revealed phase's card, carrying the DEMO badge.
  await expect(page.getByTestId("spec-demo-pill")).toHaveCount(1, {
    timeout: 15_000,
  });

  // The advance control walks the walkthrough one phase along. Capture its label,
  // click, and assert the walkthrough MOVED — either a different next-phase advance
  // label, or the terminal Reset control once it reaches 'done'.
  const advance = page.getByTestId("demo-advance-control");
  await expect(advance).toBeVisible({ timeout: 15_000 });
  const beforeLabel = (await advance.innerText()).trim();

  await advance.click();

  await expect(async () => {
    const reachedTerminal = await page.getByTestId("demo-reset-control").count();
    if (reachedTerminal > 0) return; // walked all the way to the 'done' card
    const afterLabel = (
      await page.getByTestId("demo-advance-control").innerText()
    ).trim();
    expect(afterLabel).not.toBe(beforeLabel); // advanced to the next phase
  }).toPass({ timeout: 10_000 });

  // Still exactly one demo card after advancing (reveal pointer moved, not added).
  await expect(page.getByTestId("spec-demo-pill")).toHaveCount(1);

  // ── 2. The control user's first-load landing is /home (spec-421 ac-15) ────────
  // A demo-only user has hasSpec=false (journey-state excludes is_demo), so from the
  // bare origin they land on the guidance-first Home — NOT the Specs board. This is the
  // established, deliberate behavior (spec-421 ac-15 / spec-211); the demo walkthrough is
  // reachable from the board (asserted above), never forced as the landing. The control
  // arm gives a fresh user spec-178's known-good onboarding, unchanged by the experiment.
  await page.goto(bareUrl("/"));
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("home-canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/specs(\?|#|$)/);
});
