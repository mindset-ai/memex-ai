// Journey 46 — spec-393 (workstream D of spec-388): the full lifecycle spine.
//
// The spec-388 review found there is no single continuous draft→specify→build→
// verify→done walk, and that the build→verify hop is the weak, untested seam.
// This journey closes that: it drives ONE spec through all five phases via the
// real UI status control (PhaseTabBar + TransitionSentence), asserting the phase
// pill flips at every hop — INCLUDING the build→verify and verify→done hops that
// journey-19 (which stops at specify→build) never reaches.
//
// Kill the shared-dev@ race (spec-393 dec-4 / ac-14): the structural race the
// spec-388 review found is journeys SHARING the dev user's MEMEX/spec milestone
// state (hasSpec-style flags that bleed across the serial suite). The fix is a
// UNIQUE, per-journey org + memex + spec whose state is isolated to this test —
// which is exactly what we seed below (resources.slug → torn down in afterEach).
//
// The browser auto-auths as dev@memex.ai. So we seed the org OWNED BY dev: that
// keeps dev a member/editor of THIS unique memex (TenantLayout would redirect a
// non-member away — the very std-7 behaviour journey-45 asserts), while the
// uniqueness of the org/memex/spec is what removes the cross-journey bleed. A
// freshly seeded spec has no doc_members editor row, so we promote to Editing
// once (as journey-19 does) before driving the gated forward affordances.
//
// The status control (grounded against TransitionSentence.tsx):
//   - draft→specify: the current-tab offer "Do you wish to move this spec to
//     Specify? [Yes]" (ungated).
//   - specify→build, build→verify, verify→done: the current tab is STATUS-ONLY;
//     the editor forces the move by BROWSING the forward tab → Shape 3 renders
//     "Move this spec anyway? [Yes]" (blocked) or "Are you sure…? [Yes]" (clean).
//     We click the forward tab, then the [Yes] in the transition-sentence.

import {
  test,
  expect,
  tenantPath,
  switchToEditing,
  DEV_EMAIL,
  ensureUser,
  seedOrg,
  seedSpecInMemex,
  emitAcEvents,
} from "./helpers/index.js";
import type { Page } from "@playwright/test";

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-393/acs/ac-13",
  "mindset-prod/memex-building-itself/specs/spec-393/acs/ac-14",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-46-spec-393-full-lifecycle.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

// Force a blocked/clean forward move by browsing the target tab and confirming.
async function moveForwardViaTab(page: Page, tab: string): Promise<void> {
  await page.locator(`[role="tab"][data-tab="${tab}"]`).click();
  const sentence = page.getByTestId("transition-sentence");
  // Either "Move this spec anyway?" (blocked) or "Are you sure…?" (clean) — both
  // carry a single [Yes].
  await expect(sentence).toContainText(/Move this spec anyway\?|Are you sure you want to move/i, {
    timeout: 15_000,
  });
  await sentence.getByRole("button", { name: /^Yes$/ }).click();
}

async function expectCurrentPhase(page: Page, tab: string): Promise<void> {
  await expect(
    page.locator(`[data-tab="${tab}"][data-current="true"]`),
  ).toBeVisible({ timeout: 15_000 });
}

test("full lifecycle: one spec walks draft→specify→build→verify→done via the UI status control", async ({
  page,
  resources,
}) => {
  // ── A UNIQUE per-journey org + memex + spec (isolated milestone state) ──────
  // Owned by dev so the auto-authed browser is a member/editor of THIS memex; the
  // per-journey uniqueness (resources.slug) is what kills the shared-state bleed.
  await ensureUser(DEV_EMAIL);
  const org = await seedOrg({ ownerEmail: DEV_EMAIL, slug: resources.slug("lifecycle") });

  const { docId, handle } = await seedSpecInMemex({
    memexId: org.memexId,
    title: "Lifecycle Walk Spec",
    purpose: "Drive this spec through every phase.",
  });
  resources.docIds.push(docId);

  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, `/specs/${handle}`), {
    waitUntil: "commit",
  });
  await expect(
    page.getByRole("heading", { level: 1, name: /Lifecycle Walk Spec/ }),
  ).toBeVisible({ timeout: 15_000 });

  await switchToEditing(page);

  // ── draft → specify (ungated current-tab offer) ────────────────────────────
  await expectCurrentPhase(page, "draft");
  const draftSentence = page.getByTestId("transition-sentence");
  await expect(draftSentence).toContainText(/move this spec to Specify/i);
  await draftSentence.getByRole("button", { name: /^Yes$/ }).click();
  await expectCurrentPhase(page, "specify");

  // ── specify → build (browse Build tab → "Move this spec anyway?") ──────────
  await moveForwardViaTab(page, "build");
  await expectCurrentPhase(page, "build");

  // ── build → verify (THE untested seam) ─────────────────────────────────────
  await moveForwardViaTab(page, "verify");
  await expectCurrentPhase(page, "verify");

  // ── verify → done ──────────────────────────────────────────────────────────
  // `done` is special: the PhaseTabBar is HIDDEN once phase==='done' and the
  // DoneSummary takes over (PhaseTabBar.tsx:11, DocDocument.tsx:562), so there is
  // no [data-tab="done"][data-current] pill. Assert the real done surface: the
  // done-summary card AND its Reopen control (present only when the spec is
  // actually closed, not the Done-tab preview).
  await moveForwardViaTab(page, "done");
  await expect(page.getByTestId("done-summary")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("done-reopen")).toBeVisible({ timeout: 15_000 });
});
