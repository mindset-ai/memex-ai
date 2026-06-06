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
// ── BLOCKER: the signup-as-new-user leg cannot run (ac-13 criterion 2) ────────
// ac-13 wants "a new user … signing up via native auth … landing in their
// personal memex … each step asserted in the UI … not the dev bypass". That leg
// is authored below as `test.fixme` because it is UNRUNNABLE in the e2e stack
// without a server change:
//
//   In dev mode (GOOGLE_CLIENT_ID unset, the e2e posture — see the e2e README
//   "How tests authenticate"), packages/server/src/middleware/session.ts's
//   resolveBearerUser() checks isDevMode() FIRST (session.ts:147) and returns
//   dev@memex.ai UNCONDITIONALLY (session.ts:147-152) — it never reads the
//   Authorization header (session.ts:154). So every authenticated API request
//   the browser makes resolves to the dev user, and a native-auth JWT the
//   signed-up user holds in localStorage is shadowed completely. The signup
//   API itself works (/api/auth/signup → /api/auth/verify-email, raw token via
//   the /signup-with-token test seam), but the browser session can never BE the
//   new user. Honouring a presented session JWT even in dev mode (so a real
//   token wins over the dev fallback) is the server change required — out of
//   scope for this test-authoring task, surfaced on the Spec instead of coded
//   around.
//
// Until that lands, the spine's post-authentication arc — the bulk of the
// lifecycle — runs as the (named) dev user, which still exercises org → memex →
// Spec → decision resolve → phase transitions end-to-end in the real UI on a
// cold DB. That is the running test below; the signup leg is the fixme.

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
  // decision arrives over SSE. Pick option 0, open the resolve tray, write a
  // rationale, and save.
  const panel = page.getByTestId("decision-panel");
  await expect(panel).toContainText(/Pick the spine's datastore/, { timeout: 15_000 });

  await panel.getByTestId("open-option-0").first().check();
  await panel.getByTestId("decision-resolve").first().click();
  await panel
    .getByTestId("open-resolution-text")
    .first()
    .fill("Postgres — it matches the rest of the stack.");
  await panel.getByTestId("open-resolve-confirm").first().click();

  // Resolved: the decision moves to the Resolved tray. The specify→Build Decisions
  // blocker is now satisfied — but ACs still aren't created, so the Rubicon
  // STILL blocks on ACs (the affordance reflects the remaining gate, proving the
  // phase-gated state is live, not static).
  await expect(panel.getByRole("button", { name: /^Resolved 1$/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("transition-sentence")).toContainText(
    /Acceptance Criteria \(ACs\)[\s\S]*must be created[\s\S]*before this spec can move to Build/i,
    { timeout: 15_000 }
  );

  // ── 6. Phase move specify → build, gate-aware ─────────────────────────────────
  // specify→build is gated on Decisions resolved AND ACs created. We've resolved
  // the decision but deliberately have no ACs (AC authoring is the agent/MCP
  // surface, out of this spine's scope) — so the rubric correctly REFUSES the
  // forward move: NO Yes button on the current Specify tab. That refusal IS the
  // phase-gated affordance — the spine asserts the gate holds. (Driving the move
  // all the way to verify needs the AC-create + task-complete surfaces, which
  // journey-11 and the build/verify journeys own.)
  await expect(
    page.getByTestId("transition-sentence").getByRole("button", { name: /^Yes$/ })
  ).toHaveCount(0);
});

// ── The signup-as-new-user leg — BLOCKED (see file header) ───────────────────
// Authored so the intent is recorded and the criterion is visible, marked
// `fixme` so it is reported as skipped (never a false pass) until the server
// honours a presented session JWT in dev mode. The signup + verify API calls
// are real; the assertion that the BROWSER is the new user is what cannot hold.
test.fixme(
  "new user signs up via native auth, verifies email, onboards, lands in personal memex (BLOCKED: dev-mode session shadows native-auth JWT — session.ts#resolveBearerUser)",
  async ({ page, resources }) => {
    const email = resources.email("spine-newuser");
    const { verificationToken } = await signupWithToken({
      email,
      password: "correct-horse-battery-staple-9",
    });
    resources.emails.push(email);

    // Real verification — consumes the token, stamps email_verified_at. Postmark
    // never contacted (token came from the /signup-with-token seam).
    await page.goto(
      bareUrl(`/verify-email?token=${encodeURIComponent(verificationToken)}`),
      { waitUntil: "commit" }
    );

    // From here the journey would: complete Onboarding (the name step in
    // Onboarding.tsx — fill "Your display name", press Continue), then assert it
    // lands on the new user's personal-memex Specs board. BLOCKED: in dev mode
    // the browser's session is dev@memex.ai regardless of the JWT acceptSession
    // stored, so /api/auth/me + every memex read resolve as the dev user, not
    // `email`. The onboarding screen + personal-memex landing can't be asserted
    // for the NEW user. Unblock = server honours a presented JWT over the dev
    // fallback; then this body fills in and the running test's post-auth spine
    // moves under it.
    await expect(page.getByText("What's your name?")).toBeVisible();
  }
);
