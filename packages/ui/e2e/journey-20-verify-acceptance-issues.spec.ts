// Journey 20 — Verify-phase enhancements (spec-188 / std-28 PR-gate journey).
//
// Two slices of the Verify tab (AC panel | Issue panel):
//
//   1. Manual AC acceptance — "Mark as accepted" on the AC row (the human
//      override for criteria a digital test can't exercise), the accepted
//      visual identity + provenance, evidence-wins precedence (a seeded
//      failing emission suppresses the acceptance), and "Un-accept".
//   2. Issue resolution — the resolved progress bar beneath the Issues
//      heading, the per-row Resolve button + ⋯ → Won't fix menu, the
//      "resolved" vocabulary (no "closed"), and the muted type tags on
//      non-open issues.
//
// Seeding is HTTP-only over the __test__ surface (spec-172 dec-2): seed-spec,
// seed-ac, seed-issue, seed-test-event. Navigation is path-based [per std-2].

import {
  test,
  expect,
  tenantPath,
  switchToEditing,
  seedAc,
  seedIssue,
  seedTestEvent,
  emitAcEvents,
} from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";

const SPEC188 = "mindset-prod/memex-building-itself/specs/spec-188";

// Per-test AC emission map — every test emits on pass AND fail (the
// ac-emission discipline); ac-12 (e2e coverage of all new functionality)
// rides every test in this journey.
const ACS_BY_TEST: Record<string, string[]> = {
  "AC acceptance: mark accepted → provenance + metrics, evidence suppresses, un-accept restores": [
    `${SPEC188}/acs/ac-1`,
    `${SPEC188}/acs/ac-9`,
    `${SPEC188}/acs/ac-10`,
    `${SPEC188}/acs/ac-12`,
  ],
  "Issue resolution: progress bar, Resolve + won't-fix menu, resolved vocabulary, muted tags": [
    `${SPEC188}/acs/ac-2`,
    `${SPEC188}/acs/ac-3`,
    `${SPEC188}/acs/ac-4`,
    `${SPEC188}/acs/ac-5`,
    `${SPEC188}/acs/ac-11`,
    `${SPEC188}/acs/ac-12`,
  ],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TEST[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-20-verify-acceptance-issues.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

test("AC acceptance: mark accepted → provenance + metrics, evidence suppresses, un-accept restores", async ({
  page,
  resources,
}) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j20a") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Verify acceptance journey",
    purpose: "Exercise manual AC acceptance end to end.",
  });
  const ac = await seedAc({
    memexId: tenant.memexId,
    docId: spec.docId,
    kind: "scope",
    statement: "The onboarding flow feels right (no digital test can assert this).",
  });
  expect(ac.acUid).not.toBeNull();

  // Open the Spec and browse to the Verify tab (browsable from any phase).
  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`)
  );
  await page.locator('[data-tab="verify"]').click();
  const acRow = page.locator(`[data-ac-id="${ac.acId}"]`);
  await expect(acRow).toBeVisible({ timeout: 15_000 });
  await expect(acRow).toHaveAttribute("data-ac-state", "untested");

  // ── Mark as accepted (ac-1) ────────────────────────────────────────────────
  await acRow.getByTestId("ac-accept-button").click();
  await expect(acRow).toHaveAttribute("data-ac-state", "accepted", {
    timeout: 10_000,
  });
  // Provenance names the dev user (ac-8 surface) …
  await expect(acRow.getByTestId("ac-accepted-provenance")).toContainText(
    "accepted by"
  );
  // … and the header counts the accepted AC toward the verified headline with
  // its own sky segment (ac-7 surface): 1 accepted / 1 accountable = 100%.
  const header = page.getByTestId("ac-unified-header");
  await expect(header.getByTestId("bar-segment-accepted")).toBeVisible();
  await expect(header.getByText("100%")).toBeVisible();

  // ── Evidence wins (ac-9 / dec-2): a failing emission suppresses ───────────
  await seedTestEvent({ acUid: ac.acUid!, status: "fail" });
  await expect(acRow).toHaveAttribute("data-ac-state", "failing", {
    timeout: 10_000, // panel polls every 3s
  });
  await expect(acRow.getByTestId("ac-accepted-provenance")).toContainText(
    "suppressed by failing tests"
  );

  // The same test passing again clears the evidence → back to accepted,
  // no re-accept needed.
  await seedTestEvent({ acUid: ac.acUid!, status: "pass" });
  await expect(acRow).toHaveAttribute("data-ac-state", "accepted", {
    timeout: 10_000,
  });

  // ── Un-accept (ac-10): revoke → the test-derived state returns ────────────
  await acRow.getByTestId("ac-unaccept-button").click();
  await expect(acRow).toHaveAttribute("data-ac-state", "verified", {
    timeout: 10_000,
  });
  await expect(acRow.getByTestId("ac-accepted-provenance")).not.toBeVisible();
});

test("Issue resolution: progress bar, Resolve + won't-fix menu, resolved vocabulary, muted tags", async ({
  page,
  resources,
}) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j20b") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Issue resolution journey",
    purpose: "Exercise the issue-resolution surface end to end.",
  });
  await seedIssue({
    memexId: tenant.memexId,
    docId: spec.docId,
    type: "bug",
    title: "Open bug to resolve",
  });
  await seedIssue({
    memexId: tenant.memexId,
    docId: spec.docId,
    type: "todo",
    title: "Open todo for the menu",
  });
  await seedIssue({
    memexId: tenant.memexId,
    docId: spec.docId,
    type: "bug",
    title: "Already resolved bug",
    status: "resolved",
  });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`)
  );
  await page.locator('[data-tab="verify"]').click();
  const panel = page.getByTestId("issue-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });

  // ── Vocabulary (ac-4): "resolved", never "closed" ──────────────────────────
  await expect(panel.getByText("2 open, 1 resolved")).toBeVisible();
  await expect(panel.getByText(/closed/i)).not.toBeVisible();

  // ── Progress bar (ac-2): beneath the heading, above the list ──────────────
  const resolution = panel.getByTestId("issue-resolution-header");
  await expect(resolution).toBeVisible();
  await expect(resolution.getByText("33%")).toBeVisible();
  await expect(resolution.getByTestId("metric-bar-resolved")).toBeVisible();
  await expect(resolution.getByText("1 of 3 issues resolved")).toBeVisible();

  // ── Muted type tags (ac-5): resolved bug ≠ open bug treatment ─────────────
  const openBugBadge = panel
    .locator('[data-issue-status="open"][data-issue-type="bug"]')
    .getByText("bug", { exact: true });
  const resolvedBugBadge = panel
    .locator('[data-issue-status="resolved"][data-issue-type="bug"]')
    .getByText("bug", { exact: true });
  const openClass = await openBugBadge.getAttribute("class");
  const resolvedClass = await resolvedBugBadge.getAttribute("class");
  expect(resolvedClass).not.toBe(openClass);

  // ── Resolve from the row (ac-3): dispositions need the editor posture ─────
  await switchToEditing(page);
  const openBugCard = panel.locator(
    '[data-issue-status="open"][data-issue-type="bug"]'
  );
  await openBugCard.getByTestId("issue-resolve").click();
  await expect(panel.getByText("1 open, 2 resolved")).toBeVisible({
    timeout: 10_000,
  });
  await expect(resolution.getByText("67%")).toBeVisible();

  // ── Won't fix via the ⋯ menu (ac-11) ───────────────────────────────────────
  const openTodoCard = panel.locator(
    '[data-issue-status="open"][data-issue-type="todo"]'
  );
  await openTodoCard.getByTestId("issue-menu").click();
  await panel.getByTestId("issue-wontfix").click();
  await expect(panel.getByText("0 open, 3 resolved")).toBeVisible({
    timeout: 10_000,
  });
  await expect(resolution.getByText("100%")).toBeVisible();

  // Non-open rows carry no dispositions.
  await expect(panel.getByTestId("issue-resolve")).not.toBeVisible();
  await expect(panel.getByTestId("issue-menu")).not.toBeVisible();
});
