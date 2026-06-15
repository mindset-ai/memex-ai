// Journey 19 — the product-lifecycle spine (spec-172 t-7 / ac-13).
//
// One end-to-end story of USING Memex: open an org → create a memex in it →
// create a Spec at its canonical path [per std-10] → author + resolve a decision
// → move the Spec through its phases (draft → specify → build), asserting the
// phase-gated affordances change at each step. Navigation is PATH-based on the
// single origin [per std-2]; all seeding goes over the test-only HTTP surface
// (dec-2) — no SQL, no Postmark.
//
// ── RECONCILED OVERLAP (ac-13 final criterion) ───────────────────────────────
//   - journey-11 covers the plan-submit-approve slice (execution-plan READY →
//     Approve). This spine does NOT re-walk plans; it drives the DECISION
//     resolve flow and the PHASE-TAB transitions journey-11 doesn't touch.
//   - journey-14 covers candidate-decision approve/reject (propose_decision →
//     candidate → Approve → open). This spine seeds an ALREADY-OPEN decision and
//     drives only the RESOLVE half (open-option → Resolve → rationale → Save),
//     the half journey-14 stops short of.
//
// ── The signup-as-new-user leg (ac-13 criterion 2) ───────────────────────────
// ac-13 wants "a new user … signing up via native auth … landing in their
// personal memex … each step asserted in the UI … not the dev bypass". This was
// originally BLOCKED (spec-172 issue-1): resolveBearerUser() short-circuited to
// dev@memex.ai before reading the Authorization header in dev mode, so the
// browser could never BE the signed-up user. The server now honours a presented
// valid session JWT over the dev fallback (session.ts — the dev bypass applies
// only to token-less requests), so the leg runs for real: signup via the
// /signup-with-token seam (raw email-verification token, Postmark never
// contacted) → /verify-email consumes it and stores the new user's JWT →
// Onboarding name step (the explicit onboarding-screen coverage ac-10 promises)
// → personal-memex Specs board, asserted as the NEW user, not dev@memex.ai.
//
// The post-authentication arc — org → memex → Spec → decision resolve → phase
// transitions — runs as the (named) dev user in the first test below; the
// signup leg runs as its own test with a fresh browser context so the two
// identities never share storage.

import {
  test,
  expect,
  tenantPath,
  bareUrl,
  switchToEditing,
  DEV_EMAIL,
  getPersonalMemexByEmail,
  resolveMemexId,
  seedSpecInMemex,
  seedOpenDecision,
  signupWithToken,
  emitAcEvents,
} from "./helpers/index.js";

const AC13 = ["mindset-prod/memex-building-itself/specs/spec-172/acs/ac-13"];

test.afterEach(async ({}, testInfo) => {
  // Emit on pass AND fail per the ac-emission discipline. A skipped (fixme)
  // test reports status "skipped" and emits nothing — the signup leg stays
  // visibly unverified until the server-side blocker is resolved, rather than
  // silently passing.
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC13,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-19-lifecycle-spine.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

test("lifecycle spine: org → memex → Spec → resolve decision → phase moves draft→specify→build", async ({
  page,
  resources,
}) => {
  // ── 1. From the personal context, open an Org ──────────────────────────────
  // The dev user starts on their personal memex's Specs board (globalSetup
  // names them so a cold DB doesn't route to Onboarding — ac-10). Navigate to
  // the personal namespace home, which renders "Create an Org →".
  const personal = await getPersonalMemexByEmail(DEV_EMAIL);
  expect(personal, "dev user's personal memex should be provisioned").not.toBeNull();
  const orgSlug = resources.slug("spine-org"); // tracked → afterEach tears it down

  await page.goto(bareUrl(`/${personal!.namespaceSlug}`), { waitUntil: "commit" });
  await page.getByRole("button", { name: /Create an Org/i }).click();

  // CreateOrgDialog → CreateOrgForm: type a slug, wait for the debounced
  // availability check (✓ Available), submit.
  await page.getByPlaceholder("acme").fill(orgSlug);
  await expect(page.getByLabel("slug available")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /^Create Org$/ }).click();

  // Post-create the form navigates to the new Org's namespace home (path-based,
  // /<org-namespace>). The Manage Orgs view shows the org card with "+ Add Memex".
  await expect(page).toHaveURL(new RegExp(`/${orgSlug}(/|\\?|#|$)`), { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /\+ Add Memex/ }).first()).toBeVisible({
    timeout: 15_000,
  });

  // ── 2. Create a memex in the org ───────────────────────────────────────────
  const memexSlug = "spine-mx";
  await page.getByRole("button", { name: /\+ Add Memex/ }).first().click();
  // AddMemexDialog → AddMemexForm: slug + debounced availability + Add Memex.
  await page.getByPlaceholder("main").fill(memexSlug);
  await expect(page.getByLabel("slug available")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /^Add Memex$/ }).click();

  // The dialog closes and the new memex appears in its org card (Manage Orgs
  // stays put per onCreated). Then navigate into the memex's Specs board
  // path-based [per std-2].
  await expect(
    page.getByRole("link", { name: new RegExp(`${orgSlug} / ${memexSlug}`) })
  ).toBeVisible({ timeout: 15_000 });

  await page.goto(tenantPath(orgSlug, memexSlug, "/specs"), { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
    timeout: 15_000,
  });

  // ── 3. Create a Spec, see it at its canonical path [per std-10] ────────────
  // NewSpecModal drives the in-app agent to author the Spec; that path needs the
  // Anthropic fake queued turn-by-turn (journey-8/9's surface), a heavier
  // dependency than this spine's "a Spec renders at its canonical path" assert
  // requires. We seed the Spec through the real createDocDraft service
  // (bus-emitted, SSE-visible — dec-2/std-8), then assert it renders at
  // /<ns>/<mx>/specs/<handle>. The memexId comes from the slug→id test lookup
  // (the UI org-create flow only gave us slugs).
  const memexId = await resolveMemexId(orgSlug, memexSlug);
  expect(memexId, "the created memex should resolve to an id").not.toBeNull();

  const seeded = await seedSpecInMemex({
    memexId: memexId!,
    title: "Lifecycle Spine Spec",
    purpose: "Drive this Spec through its phases.",
  });
  resources.docIds.push(seeded.docId);

  await page.goto(tenantPath(orgSlug, memexSlug, `/specs/${seeded.handle}`), {
    waitUntil: "commit",
  });
  // The Spec detail renders its title in the page <h1> (DocDocument.tsx:953).
  await expect(
    page.getByRole("heading", { level: 1, name: /Lifecycle Spine Spec/ })
  ).toBeVisible({ timeout: 15_000 });

  // The seeded Spec has no editor doc_members row → dev opens it as a REVIEWER,
  // and phase transitions + decision resolution are editor-gated. Promote to
  // Editing before driving the forward-moving affordances below.
  await switchToEditing(page);

  // ── 4. Phase-gated affordance #1: in DRAFT, draft→specify (Specify) is ungated ─
  // A freshly-created Spec is in `draft`. The PhaseTabBar shows the grey Draft
  // pill (data-tab="draft", data-current="true"); the TransitionSentence offers
  // the ungated move to Specify. draft→specify carries NO rubric blocker.
  await expect(page.locator('[data-tab="draft"][data-current="true"]')).toBeVisible({
    timeout: 15_000,
  });
  const transition = page.getByTestId("transition-sentence");
  await expect(transition).toContainText(/move this spec to Specify/i);
  await transition.getByRole("button", { name: /^Yes$/ }).click();

  // After the move the Spec is in `specify` → the Specify tab is current (filled
  // pill), the Draft pill is gone, and the phase-gated affordance CHANGED: the
  // Rubicon now states the specify→Build blockers (Decisions + ACs), not an offer.
  await expect(
    page.locator('[role="tab"][data-tab="specify"][data-current="true"]')
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-tab="draft"]')).toHaveCount(0);
  await expect(page.getByTestId("transition-sentence")).toContainText(
    /must be (created|resolved)[\s\S]*before this spec can move to Build/i,
    { timeout: 15_000 }
  );

  // ── 5. Author + resolve a decision (DecisionPanel) ─────────────────────────
  // The Plan view's "Decisions & ACs" sub-tab hosts DecisionPanel. Seed an OPEN
  // decision (bus-emitted → SSE-visible) and resolve it through the real UI.
  // (Candidate approve/reject is journey-14's job; this is the resolve half.)
  await seedOpenDecision({
    memexId: memexId!,
    docId: seeded.docId,
    title: "Pick the spine's datastore",
    context: "Two options on the table.",
    options: [
      { label: "Postgres", trade_offs: "Familiar; relational." },
      { label: "SQLite", trade_offs: "Zero-ops; single-file." },
    ],
  });

  // Open the Decisions & ACs sub-tab (sub-tabs render as <button> with the label).
  await page.getByRole("button", { name: /Decisions & ACs/ }).click();
  // DecisionPanel defaults to the Open tab when no candidates exist; the seeded
  // decision arrives over SSE. spec-247 dec-1/dec-5: picking an option IS the
  // answer — the click persists immediately (no Resolve button, no rationale).
  const panel = page.getByTestId("decision-panel");
  await expect(panel).toContainText(/Pick the spine's datastore/, { timeout: 15_000 });

  await panel.getByTestId("open-option-0").first().check();

  // Resolved: the decision becomes a resolved card in the unified list (spec-247
  // dec-7). The specify→Build Decisions blocker is now satisfied — but ACs still
  // aren't created, so the Rubicon STILL blocks on ACs (the affordance reflects
  // the remaining gate, proving the phase-gated state is live, not static).
  await expect(
    panel.locator('[data-decision-status="resolved"]').first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("transition-sentence")).toContainText(
    /Acceptance Criteria \(ACs\)[\s\S]*must be created[\s\S]*before this spec can move to Build/i,
    { timeout: 15_000 }
  );

  // ── 6. Phase move specify → build: the gate holds; the editor's escape hatch
  // relocates to the browse-forward confirm (spec-282/dec-4) ──────────────────
  // specify→build is gated on Decisions resolved AND ACs created. We've resolved
  // the decision but deliberately have no ACs (AC authoring is the agent/MCP
  // surface, out of this spine's scope) — so the rubric still NAMES the open AC
  // gate (it doesn't advance silently). spec-282/dec-4: the current tab is
  // STATUS-ONLY (no override button); the editor forces a blocked forward move
  // by browsing the Build tab and confirming "Move this spec anyway?".
  const rubicon = page.getByTestId("transition-sentence");
  await expect(rubicon).toContainText(
    /Acceptance Criteria \(ACs\)[\s\S]*must be created/i,
    { timeout: 15_000 }
  );
  await expect(rubicon).not.toContainText(/anyway\?/i);
  await expect(rubicon.getByRole("button", { name: /^Yes$/ })).toHaveCount(0);

  // The escape hatch lives on the browse-forward confirm: browse Build → the
  // "Move this spec anyway?" override [Yes].
  await page.locator('[role="tab"][data-tab="build"]').click();
  await expect(rubicon).toContainText(/Move this spec anyway\?/i, { timeout: 15_000 });
  await expect(rubicon.getByRole("button", { name: /^Yes$/ })).toHaveCount(1);
});

// ── The signup-as-new-user leg (see file header) ─────────────────────────────
// Runs as the NEW user end-to-end: the server honours the presented session JWT
// over the dev-mode fallback (spec-172 issue-1 fix), so every assertion below is
// made as `email`, not dev@memex.ai. Also the suite's explicit walk of the
// Onboarding profile screen (ac-10's second clause): a freshly signed-up user is
// nameless, so the name step renders for real — no clearUserName crutch needed.
test(
  "new user signs up via native auth, verifies email, onboards, lands in personal memex",
  async ({ page, resources }) => {
    const email = resources.email("spine-newuser");
    const { verificationToken } = await signupWithToken({
      email,
      password: "correct-horse-battery-staple-9",
    });
    resources.emails.push(email);

    // Real verification — consumes the token, stamps email_verified_at, and the
    // page stores the returned session JWT client-side (acceptSession). Postmark
    // never contacted (token came from the /signup-with-token seam).
    await page.goto(
      bareUrl(`/verify-email?token=${encodeURIComponent(verificationToken)}`),
      { waitUntil: "commit" }
    );
    await expect(
      page.getByRole("heading", { name: /You're all set!/ })
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(email)).toBeVisible();

    // Continue → the personal-memex landing. The new user is NAMELESS, so the
    // session carries needsOnboarding and the Onboarding profile screen renders
    // in place of the tenant page (App.tsx gates on session.needsOnboarding).
    await page.getByRole("button", { name: /Continue to your Memex/ }).click();
    await expect(page.getByText("What's your name?")).toBeVisible({
      timeout: 15_000,
    });

    // Complete onboarding: set the display name. updateProfileApi runs AS the
    // signed-up user (Bearer JWT) — possible only because a presented valid
    // token now wins over the dev bypass.
    const displayName = `Spine Newuser ${resources.uniq}`;
    await page.getByPlaceholder("Your display name").fill(displayName);
    await page.getByRole("button", { name: /^Continue$/ }).click();

    // The session refreshes and the personal-memex Specs board renders — as the
    // NEW user (sidebar identity shows `email`), never dev@memex.ai.
    await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText(DEV_EMAIL)).toHaveCount(0);
  }
);
