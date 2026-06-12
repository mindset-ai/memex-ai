import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  seedSection,
  setDocStatus,
} from "./helpers/retained.js";

// Journey 29 — spec-260: the Build QA Report, end to end [per std-28].
//
// Two user-facing flows:
//   1. The per-Spec artifact: a Spec carrying qa_report sections shows the
//      report front-loaded as a collapsible card in Verify, as a secondary
//      "QA Report" sub-tab in Build (default stays Tasks & Issues; quiet empty
//      state before the first hand-off), behind a gated button on the Done
//      screen — and never as plan prose in the Specify Narrative. Multiple
//      build sessions stay legible through the version switcher (ac-4, ac-7).
//   2. The workspace feed: the QA Reports nav page lists reports across Specs
//      newest-first with WHEN / WHICH-Spec / WHO per row, and the nav item
//      carries a per-user unread badge that zeroes on viewing (ac-8, ac-9,
//      ac-10).
//
// Seeding rides the env-gated /api/__test__ surface (no raw SQL); navigation is
// path-based [per std-2]. The qa_report sections are seeded through the REAL
// addSection service — the same write path the agent's write_qa_report tool
// appends through.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-260/acs/ac-${n}`;

// Per-test AC tagging, emitted pass AND fail in afterEach per the ac-emission
// discipline (helpers/emit-ac.ts routes by the ref's namespace).
const ACS_BY_TITLE: Record<string, string[]> = {
  "per-Spec seats: Build sub-tab, Verify card + versions, Done button, not in Narrative": [
    AC(4),
    AC(7),
  ],
  "workspace feed: newest-first rows with when/which/who, unread badge zeroes on view": [
    AC(8),
    AC(9),
    AC(10),
    AC(24),
  ],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TITLE[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-29-spec-260-qa-reports.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

const SESSION_ONE = "Front-end: session ONE user-visible changes.";
const SESSION_TWO = "Front-end: session TWO user-visible changes.";

test.describe("spec-260 — Build QA Report", () => {
  test("per-Spec seats: Build sub-tab, Verify card + versions, Done button, not in Narrative", async ({
    page,
    resources,
  }) => {
    const slug = resources.slug("j29a");
    const tenant = await seedOrgTenant({ slug });
    const { docId } = await seedSpec({
      memexId: tenant.memexId,
      title: "QA Report Seats Spec",
      purpose: "Spec exercising the QA report render seats.",
    });

    // ── Build, BEFORE any hand-off: the QA Report sub-tab exists with a quiet
    // empty state; Tasks & Issues stays the default view. ──
    await setDocStatus({ memexId: tenant.memexId, docId, status: "build" });
    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));
    await expect(
      page.getByRole("heading", { name: "QA Report Seats Spec", level: 1 }),
    ).toBeVisible({ timeout: 15_000 });

    // Default tab: the working two-column (Tasks panel present).
    await expect(page.getByText("Tasks & Issues")).toBeVisible();
    await page.getByText("QA Report", { exact: true }).click();
    await expect(page.getByTestId("qa-report-empty")).toContainText(
      "No QA report yet — generated when build hands off to verify",
    );

    // ── Two build sessions write their reports (the write path appendQaReport
    // rides — version keys qa_report, then qa_report-2). ──
    await seedSection({
      memexId: tenant.memexId,
      docId,
      title: "QA Report",
      content: SESSION_ONE,
      sectionType: "qa_report",
    });
    await seedSection({
      memexId: tenant.memexId,
      docId,
      title: "QA Report",
      content: SESSION_TWO,
      sectionType: "qa_report-2",
    });

    // ── Verify: the card is front-loaded above the ACs│Issues columns, shows
    // the LATEST session, collapses, and prior sessions stay reachable. ──
    await setDocStatus({ memexId: tenant.memexId, docId, status: "verify" });
    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));
    const card = page.getByTestId("qa-report-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("qa-report-content")).toContainText(SESSION_TWO);

    // History stays legible (ac-7): switch to the earlier session.
    await card.getByTestId("qa-report-version-switcher").selectOption({ index: 1 });
    await expect(card.getByTestId("qa-report-content")).toContainText(SESSION_ONE);

    // Collapsible: folds away once read.
    await card.getByTestId("qa-report-toggle").click();
    await expect(page.getByTestId("qa-report-content")).toHaveCount(0);

    // ── Specify: the report is NOT plan prose — the Narrative sub-tab never
    // renders it. ──
    await setDocStatus({ memexId: tenant.memexId, docId, status: "specify" });
    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));
    await expect(page.getByText("Narrative")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(SESSION_TWO)).toHaveCount(0);
    await expect(page.getByText(SESSION_ONE)).toHaveCount(0);

    // ── Done: the report sits behind a gated button (the "read spec" pattern)
    // and the spec read view excludes it. ──
    await setDocStatus({ memexId: tenant.memexId, docId, status: "done" });
    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));
    const qaButton = page.getByTestId("done-qa-report");
    await expect(qaButton).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("done-qa-report-body")).toHaveCount(0);
    await qaButton.click();
    await expect(page.getByTestId("done-qa-report-body")).toContainText(SESSION_TWO);
  });

  test("workspace feed: newest-first rows with when/which/who, unread badge zeroes on view", async ({
    page,
    resources,
  }) => {
    const slug = resources.slug("j29b");
    const tenant = await seedOrgTenant({ slug });

    const specA = await seedSpec({
      memexId: tenant.memexId,
      title: "Feed Spec Alpha",
      purpose: "First spec with a QA report.",
    });
    const specB = await seedSpec({
      memexId: tenant.memexId,
      title: "Feed Spec Beta",
      purpose: "Second spec with a QA report.",
    });

    // Sequential seeds → distinct created_at → deterministic newest-first.
    await seedSection({
      memexId: tenant.memexId,
      docId: specA.docId,
      title: "QA Report",
      content: "Alpha build session report.",
      sectionType: "qa_report",
    });
    await seedSection({
      memexId: tenant.memexId,
      docId: specB.docId,
      title: "QA Report",
      content: "Beta build session report.",
      sectionType: "qa_report",
    });

    // ── The nav item carries the per-user unread badge (never viewed → 2). ──
    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
    const badge = page.getByTestId("qa-reports-nav-badge");
    await expect(badge).toHaveText("2", { timeout: 15_000 });

    // ── Open the feed: newest-first, when / which-Spec / who per row. ──
    await page.getByRole("link", { name: "QA Reports" }).click();
    await expect(page).toHaveURL(/\/qa-reports$/);
    const rows = page.getByTestId("qa-report-row");
    await expect(rows).toHaveCount(2, { timeout: 15_000 });

    // Newest-first: Beta (seeded second) leads.
    await expect(rows.nth(0).getByTestId("qa-report-row-spec")).toContainText("Feed Spec Beta");
    await expect(rows.nth(1).getByTestId("qa-report-row-spec")).toContainText("Feed Spec Alpha");

    // WHEN + WHO render on every row; WHICH links to the parent Spec.
    await expect(rows.nth(0).getByTestId("qa-report-row-when")).not.toBeEmpty();
    await expect(rows.nth(0).getByTestId("qa-report-row-who")).not.toBeEmpty();
    await expect(rows.nth(0).getByTestId("qa-report-row-spec")).toHaveAttribute(
      "href",
      new RegExp(`/specs/${specB.handle}$`),
    );

    // ac-24: a first-ever view has no previous marker → EVERY row is unread and
    // arrives expanded, no click needed.
    await expect(rows.nth(0).getByTestId("qa-report-row-body")).toContainText(
      "Beta build session report.",
    );
    await expect(rows.nth(1).getByTestId("qa-report-row-body")).toContainText(
      "Alpha build session report.",
    );

    // ── Viewing the feed zeroed the badge (count-everything → 0 after view). ──
    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
    await expect(page.getByRole("link", { name: "QA Reports" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("qa-reports-nav-badge")).toHaveCount(0);

    // ac-24: revisiting — both reports are now READ → they render collapsed.
    await page.getByRole("link", { name: "QA Reports" }).click();
    const readRows = page.getByTestId("qa-report-row");
    await expect(readRows).toHaveCount(2, { timeout: 15_000 });
    await expect(readRows.nth(0).getByTestId("qa-report-row-body")).toHaveCount(0);
    await expect(readRows.nth(1).getByTestId("qa-report-row-body")).toHaveCount(0);
    // The toggle still opens a read row on demand.
    await readRows.nth(0).getByTestId("qa-report-row-toggle").click();
    await expect(readRows.nth(0).getByTestId("qa-report-row-body")).toContainText(
      "Beta build session report.",
    );

    // A THIRD report lands (a new build session elsewhere) → the badge returns.
    await seedSection({
      memexId: tenant.memexId,
      docId: specA.docId,
      title: "QA Report",
      content: "Alpha session two report.",
      sectionType: "qa_report-2",
    });
    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
    await expect(page.getByTestId("qa-reports-nav-badge")).toHaveText("1", { timeout: 15_000 });

    // ac-24: only the NEW report is unread → it alone arrives expanded.
    await page.getByRole("link", { name: "QA Reports" }).click();
    const mixedRows = page.getByTestId("qa-report-row");
    await expect(mixedRows).toHaveCount(3, { timeout: 15_000 });
    await expect(mixedRows.nth(0).getByTestId("qa-report-row-body")).toContainText(
      "Alpha session two report.",
    );
    await expect(mixedRows.nth(1).getByTestId("qa-report-row-body")).toHaveCount(0);
    await expect(mixedRows.nth(2).getByTestId("qa-report-row-body")).toHaveCount(0);
  });
});
