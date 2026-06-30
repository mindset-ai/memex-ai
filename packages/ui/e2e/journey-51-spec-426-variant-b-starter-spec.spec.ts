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
//   2. Despite that spec, hasSpec is still FALSE: from `/` the user lands on /home (the
//      landing predicate is `!hasSpec`), and the create-first-spec onboarding step is
//      NOT marked done.
//   3. When the user authors their OWN (non-demo, user-attributed) spec, hasSpec flips
//      true and `/` now lands them on the Specs board — onboarding advances only on
//      THEIR spec, never on the seeded one.
//
// Unlike the Variant-A journey, steps 1–3 do NOT depend on the Integrate landing fix —
// they exercise the CURRENT landing predicate (shouldLandOnHome = !hasSpec). The only
// prerequisite is the experiment-arm test hook (see helpers/experiments.ts); that hook
// (`POST /api/__test__/seed-experiment-arm`) is now mounted, so this journey runs for real.

import {
  test,
  expect,
  bareUrl,
  gotoSpecsBoard,
  signupWithToken,
  setIdentityConfirmed,
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
  await expect(page).toHaveURL(/\/home/, { timeout: 15_000 });

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
  // From the bare origin, the landing predicate is `!hasSpec`. A user whose only spec
  // is the system-attributed starter spec still has hasSpec=false, so they land on
  // /home — NOT the Specs board. This is the ac-3 invariant, observed end-to-end.
  await page.goto(bareUrl("/"));
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/specs(\?|#|$)/);
  await expect(page.getByTestId("home-canvas")).toBeVisible({ timeout: 15_000 });

  // The hasSpec=false proof is the /home landing above (the landing predicate is exactly
  // `!hasSpec`) and step 3 below (authoring the user's OWN spec flips the landing to
  // /specs). The onboarding canvas can't add to that proof: it is hard-gated + linear and
  // renders only the CURRENT step. A user who hasn't connected MCP is parked on the connect
  // step ("Connect to the Memex MCP", gated by mcpConnected) — strictly BEFORE the
  // create-first-spec gate (gated by hasSpec) — so create-first-spec is never rendered and
  // its "Created" done badge is necessarily absent. We assert that reality directly.
  await expect(
    page.getByRole("heading", { level: 2, name: /Connect to the Memex MCP/ }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("create-first-spec-done")).toHaveCount(0);

  // ── 3. The user authors THEIR OWN spec → hasSpec lights → onboarding advances ─
  // Seed a real, user-attributed (non-demo) spec the way the user creating their
  // first spec would — createdByUserId = the new user, is_demo=false.
  const memex = await getPersonalMemexByEmail(email);
  if (!memex) throw new Error("variant-B user has no personal memex");
  await seedSpecInMemex({
    memexId: memex.memexId,
    title: "My own first spec (variant B journey)",
    createdByUserId: userId,
  });

  // hasSpec is now true → `/` lands on the Specs board, not /home. Proof the journey
  // advances ONLY on the user's own spec, never on the seeded starter spec.
  await page.goto(bareUrl("/"));
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/home(\?|#|$)/);
});
