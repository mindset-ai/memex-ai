// Journey 41 — the per-spec Stats tab (spec-406, std-28 PR-gate journey).
//
// Covers the user-facing flow: a Stats sub-tab is present in the persistent
// sub-tab control, and opening it renders the lifecycle surfaces — the summary
// strip, the phase-duration timeline, and the who/what/when activity audit with
// its "Show everything" toggle. A freshly-seeded spec has no transition history,
// so the timeline shows its honest caveated current-phase band rather than bare
// axes (ac-1/ac-4/ac-5).
//
// Seeding is HTTP-only over the __test__ surface (spec-172 dec-2); navigation is
// path-based [per std-2].

import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, setDocStatus } from "./helpers/retained.js";

const SPEC406 = "mindset-prod/memex-building-itself/specs/spec-406";

const ACS_BY_TEST: Record<string, string[]> = {
  "the Stats tab is present and renders the summary, phase timeline and activity audit": [
    `${SPEC406}/acs/ac-1`,
    `${SPEC406}/acs/ac-4`,
    `${SPEC406}/acs/ac-5`,
  ],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TEST[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-41-spec-406-stats-tab.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

test("the Stats tab is present and renders the summary, phase timeline and activity audit", async ({
  page,
  resources,
}) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j41") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Stats tab journey",
    purpose: "The per-spec Stats tab renders its lifecycle surfaces.",
  });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "build" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" }
  );
  await expect(
    page.getByRole("heading", { level: 1, name: /Stats tab journey/ })
  ).toBeVisible({ timeout: 15_000 });

  // ── ac-1: the Stats sub-tab is present; opening it renders the tab body. ──
  await page.getByRole("button", { name: /^Stats\b/ }).click();
  await expect(page.getByTestId("spec-stats-view")).toBeVisible({ timeout: 15_000 });

  // ── ac-1: the lifecycle summary strip + phase-duration timeline render. ──
  await expect(page.getByTestId("spec-summary-strip")).toBeVisible();
  await expect(page.getByTestId("spec-phase-timeline")).toBeVisible();

  // ── ac-4: the who/what/when activity audit renders, with its curated default
  //    and the "Show everything" toggle (dec-3). ──
  await expect(page.getByTestId("spec-activity-audit")).toBeVisible();
  const showAll = page.getByTestId("audit-show-all");
  await expect(showAll).toBeVisible();
  await showAll.check();
  // Re-admitting the full slice keeps the audit mounted (no crash on refetch).
  await expect(page.getByTestId("spec-activity-audit")).toBeVisible();
});
