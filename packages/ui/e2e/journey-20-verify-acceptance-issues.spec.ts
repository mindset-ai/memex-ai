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
  seedTask,
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
    `${SPEC188}/acs/ac-13`,
  ],
  "Task completion: Build-tab metric and Verify-tab echo": [
    `${SPEC188}/acs/ac-14`,
    `${SPEC188}/acs/ac-15`,
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
  // spec-282: Issues live under the unified "Agent Tasks & Issues" sub-tab.
  await page.getByRole("button", { name: /Agent Tasks & Issues/ }).click();
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
  // spec-188 dec-4 (ac-13): the VERIFY tab's issue panel offers no
  // Convert-to-Task even in the editor posture — converting mints
  // build-phase work. Resolve is present, Convert is not.
  await expect(openBugCard.getByTestId("issue-resolve")).toBeVisible();
  await expect(panel.getByTestId("issue-convert")).not.toBeVisible();
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

test("Task completion: Build-tab metric and Verify-tab echo", async ({
  page,
  resources,
}) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j20c") });

  // Spec A: mixed completion — the Build bar reads 67%, the Verify echo warns.
  const mixed = await seedSpec({
    memexId: tenant.memexId,
    title: "Task metric journey (mixed)",
    purpose: "Exercise the task-completion metric.",
  });
  await seedTask({ memexId: tenant.memexId, docId: mixed.docId, title: "Done 1", status: "complete" });
  await seedTask({ memexId: tenant.memexId, docId: mixed.docId, title: "Done 2", status: "complete" });
  await seedTask({ memexId: tenant.memexId, docId: mixed.docId, title: "Still going", status: "in_progress" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${mixed.handle}`)
  );

  // ── Build tab: the full Metric tile (ac-14) ────────────────────────────────
  await page.locator('[data-tab="build"]').click();
  // spec-282: Tasks live under the unified "Agent Tasks & Issues" sub-tab.
  await page.getByRole("button", { name: /Agent Tasks & Issues/ }).click();
  const metric = page.getByTestId("task-completion-header");
  await expect(metric).toBeVisible({ timeout: 15_000 });
  await expect(metric.getByText("67%")).toBeVisible();
  await expect(metric.getByText("2 of 3 tasks complete")).toBeVisible();
  await expect(metric.getByTestId("metric-bar-complete")).toBeVisible();

  // ── Verify tab: the amber exception echo (ac-15) ───────────────────────────
  await page.locator('[data-tab="verify"]').click();
  // spec-282: the verify task echo rides the "Agent Tasks & Issues" sub-tab.
  await page.getByRole("button", { name: /Agent Tasks & Issues/ }).click();
  const echo = page.getByTestId("verify-task-echo");
  await expect(echo).toBeVisible();
  await expect(echo).toContainText("1 of 3 tasks incomplete");

  // Spec B: everything built — the echo is the calm green confirmation.
  const done = await seedSpec({
    memexId: tenant.memexId,
    title: "Task metric journey (complete)",
    purpose: "Exercise the calm echo.",
  });
  await seedTask({ memexId: tenant.memexId, docId: done.docId, title: "Done", status: "complete" });
  await seedTask({ memexId: tenant.memexId, docId: done.docId, title: "Also done", status: "complete" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${done.handle}`)
  );
  await page.locator('[data-tab="verify"]').click();
  await page.getByRole("button", { name: /Agent Tasks & Issues/ }).click();
  const calmEcho = page.getByTestId("verify-task-echo");
  await expect(calmEcho).toBeVisible({ timeout: 15_000 });
  await expect(calmEcho).toContainText("2/2 tasks complete");
});
