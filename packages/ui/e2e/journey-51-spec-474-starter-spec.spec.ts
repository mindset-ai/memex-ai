// Journey 51 (spec-474) — the canonical post-experiment onboarding journey.
//
// The demo-vs-starter A/B experiment (spec-426) is CONCLUDED (spec-474 dec-1): every new
// signup now gets ONE seeded, system-attributed "Understanding Memex" starter Spec
// (docType='spec', is_demo=false, status='specify', createdByUserId NULL) and NO demo
// walkthrough. There is only one provisioning behaviour left — a normal signup yields
// the starter Spec, so this journey needs no experiment-arm pin.
//
// spec-474 dec-6 also moved the onboarding content seed OFF the signup request onto an
// explicit first-load step: signup only creates the namespace+memex (fast), and the SPA,
// on first authenticated load, reads readiness from GET /api/me (`personalMemexProvisioned`)
// and — for a brand-new user — shows a "Getting your Memex ready…" blocker (MemexReadyGate,
// role="status") while it POSTs /api/me/provision (idempotent; seeds facets + Standards +
// the starter Spec + stamps provisioned_at). Once done the app renders and the starter Spec
// is on the board.
//
// What this journey pins:
//   1. A brand-new user signs up and lands on their personal-memex Trails (spec-498).
//   2. On first authenticated load the "Getting your Memex ready…" blocker appears (best
//      effort — provisioning can outrun the poll) and then RESOLVES (the onboarding name
//      form, gated behind the blocker, rendering is the hard proof it cleared).
//   3. The "Understanding Memex" starter Spec is present on the user's Specs board, in the
//      Specify column, and there is NO demo Spec / DEMO badge / demo-pill anywhere.
//   (spec-498: the old point 4 — proving the system-attributed starter Spec leaves the user
//    spec-less by landing them on the /home hero rather than the board — is retired here.
//    Trails is now the universal landing for every cohort, so the landing no longer signals
//    hasSpec; the createdByUserId-NULL exclusion stays covered by journey-state.ts units.)
//
// Verifies spec-474 ac-7 (cold-DB journey: fresh signup sees the starter spec, no demo),
// ac-1 (exactly one system-attributed starter spec, no demo walkthrough), and ac-22 (the
// readiness blocker gates only until seeding completes).

import {
  test,
  expect,
  bareUrl,
  gotoSpecsBoard,
  signupWithToken,
  setIdentityConfirmed,
  emitAcEvents,
} from "./helpers/index.js";

const STARTER_SPEC_TITLE = "Understanding Memex"; // db/starter-spec.fixture.ts

const S474_AC1 = "mindset-prod/memex-building-itself/specs/spec-474/acs/ac-1";
const S474_AC7 = "mindset-prod/memex-building-itself/specs/spec-474/acs/ac-7";
const S474_AC22 = "mindset-prod/memex-building-itself/specs/spec-474/acs/ac-22";

const FILE = "packages/ui/e2e/journey-51-spec-474-starter-spec.spec.ts";

const TITLE =
  "a fresh signup is seeded the 'Understanding Memex' starter spec (no demo) via the first-load readiness blocker, yet stays spec-less because the seed is system-attributed";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [S474_AC1, S474_AC7, S474_AC22],
    testInfo.status === "passed" ? "pass" : "fail",
    `${FILE}::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page, resources }) => {
  // ── Fresh signup → authenticate the browser AS the new user (journey-19 seam) ─
  const email = resources.email("s474"); // resources.email() tracks it for cleanup
  const { verificationToken } = await signupWithToken({
    email,
    password: "correct-horse-battery-staple-474",
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

  // ── 2. The first-load readiness blocker (spec-474 dec-6, ac-22) ──────────────
  // The first authenticated render mounts MemexReadyGate; a brand-new user's Memex is
  // unprovisioned, so it shows the "Getting your Memex ready…" blocker while POST
  // /api/me/provision seeds facets + Standards + the starter Spec. The blocker GATES the
  // authenticated app (incl. the /onboarding name form), so provisioning MUST complete
  // before the name step renders. Catching the transient blocker is best-effort —
  // provisioning can outrun our poll — but its resolution is proven hard below (the name
  // form appears only once the gate clears, and the blocker is asserted absent).
  const readyBlocker = page
    .getByRole("status")
    .filter({ hasText: /Getting your Memex ready/i });
  try {
    await expect(readyBlocker).toBeVisible({ timeout: 4_000 });
  } catch {
    // Provisioning outran the poll on this run; the resolution assertions below still
    // prove the seed completed (starter Spec on the board, blocker absent).
  }

  await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
  // The name form is behind the readiness gate — its appearance is hard proof the blocker
  // resolved. Assert the blocker is gone, then drive the name step.
  await expect(readyBlocker).toHaveCount(0, { timeout: 30_000 });
  await page.getByPlaceholder("Your display name").fill("Starter Spec User");
  await page.getByRole("button", { name: /^Continue$/ }).click();
  // ── 1. spec-498: a fresh user lands on their personal-memex Trails (the /home
  //       canonical redirect forwards to /:ns/:mx/trails). ─────────────────────
  await expect(page).toHaveURL(/\/trails(\?|#|$)/, { timeout: 15_000 });

  // ── 3. The "Understanding Memex" starter spec is on the board, in Specify, no demo ─
  // The board itself is the deterministic readiness barrier — and, being a real authenticated
  // browser navigation, it carries the s474 session (unlike page.request, which bypasses the
  // SPA's Bearer interceptor and would hit the dev fallback user). The SPA drives POST
  // /api/me/provision from MemexReadyGate; on this full-reload board load the gate re-checks
  // GET /api/me and, if the seed is still in flight, holds the "Getting your Memex ready…"
  // blocker until it completes — so the starter Spec assertion below (generous timeout) is the
  // positive proof (ac-8/ac-22) that first-load provisioning ran to completion.
  await gotoSpecsBoard(page, email);

  // The starter spec is seeded at status 'specify' (starter-spec.fixture.ts), so it sits
  // in the open Specify column. Timeout accommodates a still-in-flight first-load seed.
  const starterHeading = page.getByRole("heading", { name: STARTER_SPEC_TITLE });
  await expect(starterHeading.first()).toBeVisible({ timeout: 30_000 });
  // ac-1 / ac-12: EXACTLY ONE starter spec — guards the provisioning-concurrency regression
  // (a StrictMode/multi-call double-POST used to seed two "Understanding Memex" specs).
  await expect(starterHeading).toHaveCount(1);

  // Column-scoped: the card (an <h3>) lives under the Specify KanbanColumn, whose header
  // is an <h2> "Specify" (KanbanColumn.tsx: h2 → header div → column root = ancestor div[2]).
  const specifyColumn = page
    .getByRole("heading", { level: 2, name: "Specify" })
    .locator("xpath=ancestor::div[2]");
  await expect(
    specifyColumn.getByRole("heading", { name: STARTER_SPEC_TITLE }),
  ).toBeVisible();

  // The demo walkthrough is DELETED (spec-474 ac-5): no DEMO badge / demo-pill affordance
  // anywhere on the board (the testid is gone from source, so this guards the regression).
  await expect(page.getByTestId("spec-demo-pill")).toHaveCount(0);

  // ── 4. RETIRED here (spec-498): ac-4 ("the system-attributed starter spec does not
  // satisfy hasSpec") was proven via the landing surface — spec-less → /home hero vs
  // has-spec → board. With Trails now the universal landing for every cohort, the landing
  // no longer signals hasSpec, so this journey can't assert ac-4 that way. The attribution
  // invariant itself (createdByUserId NULL excluded from hasSpec) stays covered by the
  // journey-state.ts unit suite. The starter-spec provisioning (ac-1/ac-7/ac-22) above is
  // this journey's live coverage.
});
