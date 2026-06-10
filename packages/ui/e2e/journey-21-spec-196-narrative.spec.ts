// Journey 21 — spec-196 (std-28 PR-gate journey).
//
// Two user-facing flows this Spec adds:
//
//   1. The specify→build narrative gate: with every decision resolved but the
//      spec narrative stale (decisions newer than narrativeLastConsolidatedAt),
//      the Rubicon line states that the SPEC NARRATIVE must be updated — with
//      the how — instead of offering the move to Build. Once consolidation
//      stamps the timestamp, the advancement offer appears. (ac-3, ac-4, ac-9)
//   2. The done view's "Read the spec" control: any viewer expands the full
//      record inline — narrative sections + decisions/tasks/ACs/issues — with
//      no reopen and no phase change. (ac-12)
//
// Seeding goes over the env-gated test surface (no raw SQL): seed-spec,
// seed-open-decision, seed-ac, seed-task, set-doc-status, consolidate-narrative.
// Navigation is path-based [per std-2]. The prose sub-tab reading "Narrative"
// (spec-233 t-1, reversing spec-196 dec-1's "Spec") is asserted inline in the
// gate test below; the layout walk also lives in journey-15.

import {
  test,
  expect,
  tenantPath,
  switchToEditing,
  seedAc,
  seedTask,
  seedOpenDecision,
  emitAcEvents,
} from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  setDocStatus,
  consolidateNarrative,
} from "./helpers/retained.js";

const SPEC196 = "mindset-prod/memex-building-itself/specs/spec-196";
const SPEC233 = "mindset-prod/memex-building-itself/specs/spec-233";
const ACS_BY_TEST: Record<string, string[]> = {
  "specify→build gate: stale narrative blocks the offer; consolidation restores it": [
    `${SPEC196}/acs/ac-3`,
    `${SPEC196}/acs/ac-4`,
    `${SPEC196}/acs/ac-9`,
    // spec-233 t-1: the prose sub-tab reads "Narrative" and still routes (ac-2);
    // no UI/flow asserts the old "Spec" label (ac-5).
    `${SPEC233}/acs/ac-2`,
    `${SPEC233}/acs/ac-5`,
  ],
  '"Read the spec" on a done Spec: full record inline, no reopen, no phase change': [
    `${SPEC196}/acs/ac-12`,
  ],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TEST[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-21-spec-196-narrative.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

test("specify→build gate: stale narrative blocks the offer; consolidation restores it", async ({
  page,
  resources,
}) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j21a") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Narrative gate journey",
    purpose: "Exercise the spec-narrative staleness gate.",
  });

  // Shape the rubric so the ONLY remaining specify→build condition after the
  // decision resolves is narrative freshness: an AC exists, one open decision.
  await seedAc({
    memexId: tenant.memexId,
    docId: spec.docId,
    kind: "scope",
    statement: "The gate journey passes.",
  });
  await seedOpenDecision({
    memexId: tenant.memexId,
    docId: spec.docId,
    title: "Pick the gate's colour",
    context: "Amber or green.",
    options: [
      { label: "Amber", trade_offs: "Cautious." },
      { label: "Green", trade_offs: "Confident." },
    ],
  });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "specify" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`)
  );
  // While the decision is open, the decisions blocker leads — no narrative talk.
  const rubicon = page.getByTestId("transition-sentence");
  await expect(rubicon).toContainText(/1 Decision must be resolved/i, { timeout: 15_000 });
  await expect(rubicon).not.toContainText(/spec narrative/i);

  // spec-233 t-1 (ac-2, ac-5): the prose sub-tab reads "Narrative", not "Spec"
  // — "Spec" names the whole object. Clicking it opens the prose view, and the
  // unchanged 'narrative' id keeps routing working (away to Decisions & ACs and
  // back).
  const subTabs = page.getByTestId("canvas");
  const narrativeTab = subTabs.getByRole("button", { name: "Narrative", exact: true });
  await expect(narrativeTab).toBeVisible({ timeout: 15_000 });
  await expect(subTabs.getByRole("button", { name: "Spec", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Decisions & ACs/ }).click();
  await expect(page.getByTestId("decision-panel")).toBeVisible({ timeout: 15_000 });
  await narrativeTab.click();
  await expect(page.getByText("Exercise the spec-narrative staleness gate.")).toBeVisible({
    timeout: 15_000,
  });

  // Resolve the decision through the real UI (editor posture required).
  await switchToEditing(page);
  await page.getByRole("button", { name: /Decisions & ACs/ }).click();
  const panel = page.getByTestId("decision-panel");
  await expect(panel).toContainText(/Pick the gate's colour/, { timeout: 15_000 });
  await panel.getByTestId("open-option-1").first().check();
  await panel.getByTestId("decision-resolve").first().click();
  await panel.getByTestId("open-resolution-text").first().fill("Green — we're confident.");
  await panel.getByTestId("open-resolve-confirm").first().click();
  await expect(panel.getByRole("button", { name: /^Resolved 1$/ })).toBeVisible({
    timeout: 15_000,
  });

  // All decisions resolved + AC present + never consolidated → the Rubicon
  // states the staleness condition WITH the how-to tail, and offers no move.
  await expect(rubicon).toContainText(
    /The spec narrative must be updated to reflect the resolved decisions before this spec can move to Build — use the refresh action to generate the update prompt\./,
    { timeout: 15_000 }
  );
  await expect(rubicon.getByRole("button", { name: /^Yes$/ })).toHaveCount(0);

  // Consolidate (what assess_spec({mode:'consolidate'}) stamps) → the live
  // change stream refreshes the doc and the advancement offer appears.
  await consolidateNarrative({ memexId: tenant.memexId, docId: spec.docId });
  await expect(rubicon).toContainText(/Do you wish to move this spec to Build\?/, {
    timeout: 15_000,
  });
  await expect(rubicon).not.toContainText(/spec narrative/i);
});

test('"Read the spec" on a done Spec: full record inline, no reopen, no phase change', async ({
  page,
  resources,
}) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j21b") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Done read journey",
    purpose: "The whole narrative readable in place.",
  });
  await seedTask({
    memexId: tenant.memexId,
    docId: spec.docId,
    title: "Ship the read control",
    status: "complete",
  });
  await seedAc({
    memexId: tenant.memexId,
    docId: spec.docId,
    kind: "scope",
    statement: "Readers read without reopening.",
  });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "done" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`)
  );

  // The done report renders. The dev user opens the seeded Spec as a REVIEWER
  // (no doc_members row) but WITH org write access — so spec-196's relaxed gate
  // shows BOTH the read control (reading is not a write) and Reopen (gated on
  // write access, not editor posture). Both sit on one footer row.
  const report = page.getByTestId("done-summary");
  await expect(report).toContainText(/completed on/, { timeout: 15_000 });
  await expect(page.getByTestId("done-reopen")).toBeVisible();
  const toggle = page.getByTestId("done-read-spec");
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId("done-read-spec-body")).toHaveCount(0);

  // Expand: the full record — narrative prose, task, AC — inline, read-only.
  await toggle.click();
  const body = page.getByTestId("done-read-spec-body");
  await expect(body).toContainText("The whole narrative readable in place.");
  await expect(body).toContainText("Ship the read control");
  await expect(body).toContainText("Readers read without reopening.");
  // No mutation affordances inside the record.
  await expect(body.getByRole("button")).toHaveCount(0);

  // Collapse — and the Spec never left `done` (the phase pill still says so;
  // expanding was pure presentation).
  await toggle.click();
  await expect(page.getByTestId("done-read-spec-body")).toHaveCount(0);
  await expect(report).toContainText(/completed on/);
});
