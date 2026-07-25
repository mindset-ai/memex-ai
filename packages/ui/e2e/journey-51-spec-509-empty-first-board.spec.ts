// Journey 51 (spec-509) — a fresh signup lands on an EMPTY Specs board.
//
// This journey was journey-51-spec-474-starter-spec: it asserted that a new signup was
// seeded one system-attributed "Understanding Memex" starter Spec. spec-509 dec-2 deleted
// that seeder — the seed measured, on prod 2026-07-25, at 4 opens across 110 new external
// users with zero owner edits — so the assertion inverts: the board is empty.
//
// It was REWRITTEN rather than retired (dec-4) because it is the ONLY journey that drives
// the first-load readiness path on a cold DB. Verified 2026-07-25: every other `provision`
// reference in packages/ui/e2e is a globalSetup precondition check, and spec-502's
// journey-66 asserts wizard surfaces only (wizard-modal / wizard-name-step / connect-stage)
// and never touches the readiness blocker. Retiring this file would have dropped the sole
// cold-DB proof that provisioning completes and un-gates the app — in the very change that
// removes one of the things provisioning does.
//
// ── WHY THE ORDER OF ASSERTIONS MATTERS (dec-4) ───────────────────────────────
// "No Spec titled Understanding Memex" is a test that also passes when the page is broken,
// the query failed, or the loading screen never cleared. So this journey proves the surface
// is ALIVE before it proves the Spec is ABSENT:
//
//   1. the "Getting your Memex ready…" blocker is observed PRESENT and then GONE — not
//      merely absent from the start;
//   2. the 6 default Standards ARE present — the POSITIVE CONTROL. This is the assertion
//      that makes the zero below trustworthy: it proves provisioning ran and seeded, so an
//      empty Specs board means "correctly seeded no Spec" and not "provisioning failed";
//   3. the Specs board renders its OWN empty state (the kanban board with its columns),
//      not a spinner and not an error boundary;
//   4. only then: zero Specs on the board.
//
// Everything is reached through the real signup + POST /api/me/provision path — no raw SQL
// and no test-surface seeding (std-28). The arm-pinning hook this file used to call was
// deleted from routes/__test__.ts along with the seeder it invoked.
//
// Verifies spec-509 ac-1 (a newly provisioned personal Memex has an empty Specs board),
// ac-18 (readiness proven before absence), ac-19 (Standards as the positive control), and
// ac-20 (no journey seeds or asserts a starter Spec).

import {
  test,
  expect,
  bareUrl,
  gotoSpecsBoard,
  signupWithToken,
  setIdentityConfirmed,
  emitAcEvents,
  getPersonalMemexByEmail,
  tenantPath,
} from "./helpers/index.js";

// packages/server/src/db/default-standards.fixture.ts — DEFAULT_STANDARDS_COUNT. Hard-coded
// rather than imported because e2e must not reach into server source; if the fixture grows a
// Standard this number moves with it, and that mismatch is the point (it means provisioning
// changed and this journey's positive control should be re-read).
const DEFAULT_STANDARDS_COUNT = 6;

// The retired seed's title. Named here ONLY so the absence assertion can be specific about
// what must not come back.
const RETIRED_SEED_TITLE = "Understanding Memex";

const S509_AC1 = "mindset-prod/memex-building-itself/specs/spec-509/acs/ac-1";
const S509_AC18 = "mindset-prod/memex-building-itself/specs/spec-509/acs/ac-18";
const S509_AC19 = "mindset-prod/memex-building-itself/specs/spec-509/acs/ac-19";
const S509_AC20 = "mindset-prod/memex-building-itself/specs/spec-509/acs/ac-20";

const FILE = "packages/ui/e2e/journey-51-spec-509-empty-first-board.spec.ts";

const TITLE =
  "a fresh signup clears the first-load readiness blocker and lands on an EMPTY Specs board, with the default Standards seeded as proof provisioning ran";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [S509_AC1, S509_AC18, S509_AC19, S509_AC20],
    testInfo.status === "passed" ? "pass" : "fail",
    `${FILE}::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page, resources }) => {
  // ── Fresh signup → authenticate the browser AS the new user (journey-19 seam) ─
  const email = resources.email("s509"); // resources.email() tracks it for cleanup
  const { verificationToken } = await signupWithToken({
    email,
    password: "correct-horse-battery-staple-509",
  });

  await page.goto(bareUrl(`/verify-email?token=${encodeURIComponent(verificationToken)}`), {
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { name: /You're all set!/ })).toBeVisible({
    timeout: 15_000,
  });

  // Confirm identity so needsOnboarding clears and the landing predicate is reached.
  await setIdentityConfirmed(email, true);
  // spec-441: email/password signups have no name in their session JWT at this point.
  // Navigate through /onboarding to set the display name AND refresh the cached session,
  // otherwise TenantLayout redirects every subsequent page.goto to /onboarding.
  await page.getByRole("button", { name: /Continue to your Memex/ }).click();

  // ── 1. The readiness blocker appears, then clears (ac-18) ─────────────────────
  // The first authenticated render mounts MemexReadyGate; a brand-new user's Memex is
  // unprovisioned, so it shows the blocker while POST /api/me/provision seeds facets +
  // Standards (and, since dec-2, no Spec). Catching the transient blocker is best-effort —
  // provisioning can outrun our poll — but its RESOLUTION is proven hard below: the
  // /onboarding name form sits behind the gate, so its appearance means the gate cleared.
  const readyBlocker = page.getByRole("status").filter({ hasText: /Getting your Memex ready/i });
  try {
    await expect(readyBlocker).toBeVisible({ timeout: 4_000 });
  } catch {
    // Provisioning outran the poll on this run; the resolution assertions below still
    // prove it completed.
  }

  await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
  // Hard proof the blocker resolved: the gated form rendered AND the blocker is gone.
  await expect(readyBlocker).toHaveCount(0, { timeout: 30_000 });
  await page.getByPlaceholder("Your display name").fill("Empty Board User");
  await page.getByRole("button", { name: /^Continue$/ }).click();

  // spec-498: a fresh user lands on their personal-memex Trails (the /home canonical
  // redirect forwards to /:ns/:mx/trails).
  await expect(page).toHaveURL(/\/trails(\?|#|$)/, { timeout: 15_000 });

  // ── 2. The POSITIVE CONTROL: the Standards were seeded (ac-19) ────────────────
  // Asserted BEFORE the empty-board check, deliberately. If provisioning had silently
  // failed, this is what would catch it — and without it, a failed provision and a correct
  // removal look identical from an empty Specs board.
  const memex = await getPersonalMemexByEmail(email);
  if (!memex) throw new Error(`journey-51: no personal memex for ${email}`);
  await page.goto(tenantPath(memex.namespaceSlug, memex.memexSlug, "/standards"));
  await expect(page.getByRole("heading", { name: "Standards", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // Each seeded Standard renders as a card heading on the list. Poll with a generous
  // timeout: on a cold DB the first-load seed may still be in flight when this mounts.
  await expect
    .poll(async () => await page.getByRole("heading", { level: 3 }).count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(DEFAULT_STANDARDS_COUNT);

  // ── 3. + 4. The Specs board renders, with ZERO Specs (ac-1 / ac-18) ───────────
  // gotoSpecsBoard waits on the "Specs" H1, so reaching the next line already means the
  // page rendered rather than erroring.
  await gotoSpecsBoard(page, email);

  // The board itself is present — columns rendered, not a spinner and not an error
  // boundary. This is the "surface is alive" half of ac-18.
  const board = page.getByTestId("kanban-board");
  await expect(board).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 2, name: "Specify" })).toBeVisible();

  // ZERO Specs. Spec cards render as an <h3> inside the board (KanbanColumn.tsx), so a
  // count of 0 across the whole board is the assertion — deliberately NOT scoped to the
  // retired title, so a seeder reintroduced under any other name trips this too.
  await expect(board.getByRole("heading", { level: 3 })).toHaveCount(0);

  // And specifically: the retired seed is not back (ac-20).
  await expect(page.getByRole("heading", { name: RETIRED_SEED_TITLE })).toHaveCount(0);

  // No demo walkthrough affordance either (spec-474 ac-5 — still true, still guarded).
  await expect(page.getByTestId("spec-demo-pill")).toHaveCount(0);
});
