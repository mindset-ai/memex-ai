import {
  test,
  expect,
  tenantPath,
  switchToEditing,
  emitAcEvents,
} from "./helpers/index.js";
import { seedOrgTenant, seedFacetScenario } from "./helpers/retained.js";

// Journey 50 — spec-423 (dec-7): a cast facet ballot renders as pills on the task
// and decision cards, so users meet no new concept. This is the only end-to-end
// proof that the consume-side ballot surfaces in the web UI.
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-423/acs/ac-${n}`;
const ACS = [15].map(AC);

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-50-spec-423-facet-pills.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("a balloted task and decision render their facet pills", async ({ page, resources }) => {
  const slug = resources.slug("j50");
  const tenant = await seedOrgTenant({ slug });
  const { specHandle, facetKey } = await seedFacetScenario({ memexId: tenant.memexId });

  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${specHandle}`), {
    waitUntil: "domcontentloaded",
  });
  await switchToEditing(page);

  // ── Decision card shows the facet pill ──
  await page.getByRole("button", { name: /Decisions.* ACs/ }).click();
  const decisionPanel = page.getByTestId("decision-panel");
  await expect(decisionPanel.getByTestId("decision-card").first()).toBeVisible({ timeout: 15_000 });
  const decisionPill = decisionPanel.getByTestId("facet-pill").filter({ hasText: facetKey });
  await expect(decisionPill.first()).toBeVisible();

  // ── Task card shows the facet pill ──
  await page.getByRole("tab", { name: "Build" }).click();
  await page.getByRole("button", { name: /Agent Tasks.* Issues/ }).click();
  const taskPanel = page.getByTestId("task-panel");
  await expect(taskPanel.getByTestId("task-card").first()).toBeVisible({ timeout: 15_000 });
  const taskPill = taskPanel.getByTestId("facet-pill").filter({ hasText: facetKey });
  await expect(taskPill.first()).toBeVisible();
});
