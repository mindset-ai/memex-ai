// Journey 51 (spec-426) — Variant B: a fresh signup pinned to the TREATMENT arm
// (starter_spec) receives the real "Understanding Memex" starter spec, yet that spec
// does NOT satisfy the user's hasSpec milestone — they must author their OWN spec for
// onboarding to advance.
//
// This is the second journey ac-16 promises (spec-426 s-5). It pins the hard
// correctness invariant of dec-3 / ac-3: the starter spec is is_demo=false (real,
// searchable, on the board) BUT system-attributed (created_by_user_id NULL), so it can
// never light `hasSpec` — which gates on created_by_user_id = the user
// (journey-state.ts). The seed being a real, editable spec must NOT short-circuit the
// user's onboarding the way a user-authored spec would.
//
// What this journey pins:
//   1. The "Understanding Memex" starter spec IS present on the user's board, and it
//      is NOT a demo (no DEMO badge anywhere — Variant B replaced the frozen demo).
//   2. Despite that spec, hasSpec is still FALSE. spec-461 retired the auto-/home landing,
//      so hasSpec no longer shows in the landing target; we observe it via the onboarding
//      canvas (reached by explicit /home nav): the user is still parked on the Connect-MCP
//      step and create-first-spec is not done — the seed did not advance onboarding.
//   3. When the user authors their OWN (non-demo, user-attributed) spec, it appears on the
//      board DISTINCT from the seeded starter spec — the required authorship that lights the
//      hasSpec milestone (computed in journey-state.ts, unit-covered).
//
// The invariant under test (system-attributed seed never lights hasSpec) is unchanged by
// spec-461; only the OBSERVABLE moved from the /home landing to the onboarding canvas +
// board. The prerequisite is the experiment-arm test hook (see helpers/experiments.ts); that
// hook (`POST /api/__test__/seed-experiment-arm`) is now mounted, so this journey runs for real.

import {
  test,
  expect,
  bareUrl,
  gotoSpecsBoard,
  signupWithToken,
  setIdentityConfirmed,
  dismissWelcomeVideo,
  getPersonalMemexByEmail,
  seedSpecInMemex,
  emitAcEvents,
} from "./helpers/index.js";
import { seedExperimentArm } from "./helpers/experiments.js";

const STARTER_SPEC_TITLE = "Understanding Memex"; // db/starter-spec.fixture.ts

const S426_AC3 = "mindset-prod/memex-building-itself/specs/spec-426/acs/ac-3";
const S426_AC16 = "mindset-prod/memex-building-itself/specs/spec-426/acs/ac-16";

const FILE =
  "packages/ui/e2e/journey-51-spec-426-variant-b-starter-spec.spec.ts";

const TITLE =
  "Variant B (treatment): the seeded 'Understanding Memex' starter spec is present but system-attributed, so the user must author their own spec before hasSpec lights";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [S426_AC3, S426_AC16],
    testInfo.status === "passed" ? "pass" : "fail",
    `${FILE}::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page, resources }) => {
  // ── Fresh signup → authenticate the browser AS the new user (journey-19 seam) ─
  const email = resources.email("v426b"); // resources.email() tracks it for cleanup
  const { userId, verificationToken } = await signupWithToken({
    email,
    password: "correct-horse-battery-staple-B",
  });

  await page.goto(
    bareUrl(`/verify-email?token=${encodeURIComponent(verificationToken)}`),
    { waitUntil: "commit" },
  );
  await expect(
    page.getByRole("heading", { name: /You're all set!/ }),
  ).toBeVisible({ timeout: 15_000 });

  // Confirm identity so needsOnboarding clears and the landing predicate is reached.
  await setIdentityConfirmed(email, true);
  // spec-441: email/password signups have no name in their session JWT at this point.
  // Navigate through /onboarding to set the display name AND refresh the cached session,
  // otherwise TenantLayout redirects every subsequent page.goto to /onboarding.
  await page.getByRole("button", { name: /Continue to your Memex/ }).click();
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
  await page.getByPlaceholder("Your display name").fill("Variant B User");
  await page.getByRole("button", { name: /^Continue$/ }).click();
  // spec-444: dismiss welcome video gate that fires for new users after name capture.
  // (Clicking the CTA sets welcomeVideoDismissed for this session.)
  await dismissWelcomeVideo(page);
  // spec-461: a fresh user now lands on their Specs board (the auto-/home landing was retired).
  await expect(page).toHaveURL(/\/specs/, { timeout: 15_000 });

  // ── Pin the TREATMENT arm + seed the starter spec deterministically ──────────
  // The experiment-arm test hook (POST /api/__test__/seed-experiment-arm) is now
  // mounted, so this runs for real — supersedes the auto assignment with an
  // operator pin to the treatment arm and re-seeds the "Understanding Memex" spec.
  await seedExperimentArm({ email, behaviour: "starter_spec" });

  // ── 1. The "Understanding Memex" starter spec is on the board, and is NOT a demo ─
  await gotoSpecsBoard(page, email);

  // The starter spec is seeded at status 'specify' (dec-3 revision), so it sits in the
  // open Specify column with its narrative on show — no collapsed rail to expand.
  await expect(
    page.getByRole("heading", { name: STARTER_SPEC_TITLE }),
  ).toBeVisible({ timeout: 15_000 });

  // Variant B replaced the frozen demo with a REAL spec — there is no DEMO badge
  // anywhere on the board (the demo's progressive-reveal walkthrough is absent).
  await expect(page.getByTestId("spec-demo-pill")).toHaveCount(0);

  // ── 2. The starter spec does NOT satisfy hasSpec (it is system-attributed) ────
  // Post-461 the landing is /specs regardless of hasSpec, so it no longer signals whether the
  // user is engaged. We inspect onboarding progress directly by navigating to /home (still
  // reachable by explicit nav): the onboarding canvas is hard-gated + linear and renders only
  // the CURRENT step. With the starter spec system-attributed (hasSpec=false) and MCP not yet
  // connected, the user is parked on the Connect-MCP step — strictly BEFORE the create-first-
  // spec gate (gated by hasSpec) — so create-first-spec is never rendered and its "Created"
  // done badge is necessarily absent. That is the ac-3 invariant: the seeded starter spec did
  // NOT advance the user's onboarding.
  await page.goto(bareUrl("/home"));
  await expect(
    page.getByRole("heading", { level: 2, name: /Connect to the Memex MCP/ }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("create-first-spec-done")).toHaveCount(0);

  // ── 3. The user authors THEIR OWN spec — the action ac-3 says is required ─────
  // Seed a real, user-attributed (non-demo) spec the way the user creating their first spec
  // would — createdByUserId = the new user, is_demo=false. It now sits on the board DISTINCT
  // from the system-attributed starter spec: proof the user's own authorship (the event that
  // lights the hasSpec milestone in journey-state.ts, unit-covered) is separate from the seed.
  const memex = await getPersonalMemexByEmail(email);
  if (!memex) throw new Error("variant-B user has no personal memex");
  await seedSpecInMemex({
    memexId: memex.memexId,
    title: "My own first spec (variant B journey)",
    createdByUserId: userId,
  });

  await gotoSpecsBoard(page, email);
  await expect(
    page.getByRole("heading", { name: "My own first spec (variant B journey)" }),
  ).toBeVisible({ timeout: 15_000 });
  // The seeded starter spec is still present too — the two are distinct.
  await expect(page.getByRole("heading", { name: STARTER_SPEC_TITLE })).toBeVisible();
});
