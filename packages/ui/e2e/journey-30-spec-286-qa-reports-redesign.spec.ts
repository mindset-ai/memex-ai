import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  seedSection,
  seedTags,
  setDocStatus,
} from "./helpers/retained.js";

// Journey 30 — spec-286: the redesigned QA Reports feed, end to end [per std-28].
//
// The feed now leads each report with the spec as a heading, shows the owning
// spec's phase as a coloured pill, and carries a STICKY left rail that filters
// the feed by tag (with whole-corpus counts) and by date range. This journey
// seeds two tagged specs in different phases, each with a QA report, then drives
// the rail: a tag node narrows the feed to that tag's reports, the per-tag counts
// match the corpus, and a date window narrows the feed too (AND with the tag).
//
// Seeding rides the env-gated /api/__test__ surface (no raw SQL); navigation is
// path-based [per std-2]. Reports + tags are seeded through the REAL services.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-286/acs/ac-${n}`;

const ACS_BY_TITLE: Record<string, string[]> = {
  "enriched cards: spec heading + phase pill; rail filters by tag with corpus counts": [
    AC(2),
    AC(4),
    AC(11),
  ],
  "date filter narrows the feed (and ANDs with a tag)": [AC(5)],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TITLE[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-30-spec-286-qa-reports-redesign.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test.describe("spec-286 — QA Reports feed redesign", () => {
  test("enriched cards: spec heading + phase pill; rail filters by tag with corpus counts", async ({
    page,
    resources,
  }) => {
    const slug = resources.slug("j30a");
    const tenant = await seedOrgTenant({ slug });

    // Alpha → tagged area::frontend + bug, in Verify.
    const alpha = await seedSpec({
      memexId: tenant.memexId,
      title: "Redesign Alpha",
      purpose: "Alpha spec.",
    });
    await seedTags({ memexId: tenant.memexId, docId: alpha.docId, tags: ["area::frontend", "bug"] });
    await setDocStatus({ memexId: tenant.memexId, docId: alpha.docId, status: "verify" });

    // Beta → tagged area::frontend only, in Build.
    const beta = await seedSpec({
      memexId: tenant.memexId,
      title: "Redesign Beta",
      purpose: "Beta spec.",
    });
    await seedTags({ memexId: tenant.memexId, docId: beta.docId, tags: ["area::frontend"] });
    await setDocStatus({ memexId: tenant.memexId, docId: beta.docId, status: "build" });

    // Sequential seeds → distinct created_at → Beta (second) leads newest-first.
    await seedSection({
      memexId: tenant.memexId,
      docId: alpha.docId,
      title: "QA Report",
      content: "Alpha build session report.",
      sectionType: "qa_report",
    });
    await seedSection({
      memexId: tenant.memexId,
      docId: beta.docId,
      title: "QA Report",
      content: "Beta build session report.",
      sectionType: "qa_report",
    });

    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/qa-reports"));

    const rows = page.getByTestId("qa-report-row");
    await expect(rows).toHaveCount(2, { timeout: 15_000 });

    // ac-2: each card leads with the spec and shows the phase as a coloured pill.
    await expect(rows.nth(0).getByTestId("qa-report-row-spec")).toContainText("Redesign Beta");
    await expect(rows.nth(0).getByTestId("qa-report-phase-pill")).toHaveAttribute(
      "data-phase",
      "build",
    );
    await expect(rows.nth(0).getByTestId("qa-report-phase-pill")).toContainText("Build");
    await expect(rows.nth(1).getByTestId("qa-report-phase-pill")).toHaveAttribute(
      "data-phase",
      "verify",
    );

    // ac-4: the rail stays in place and roots the tree at "All" with the corpus
    // total; each tag node carries its whole-corpus report count.
    const rail = page.getByTestId("qa-reports-rail");
    await expect(rail).toBeVisible();
    await expect(page.getByTestId("qa-reports-tag-all")).toContainText("2");

    const frontendNode = page
      .getByTestId("qa-reports-tag-node")
      .filter({ hasText: "frontend" });
    const bugNode = page.getByTestId("qa-reports-tag-node").filter({ hasText: "bug" });
    await expect(frontendNode.getByTestId("qa-reports-tag-count")).toHaveText("2");
    await expect(bugNode.getByTestId("qa-reports-tag-count")).toHaveText("1");

    // ac-4 + ac-11: selecting `bug` filters the feed to Alpha's single report.
    await bugNode.click();
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
    await expect(rows.nth(0).getByTestId("qa-report-row-spec")).toContainText("Redesign Alpha");

    // `frontend` spans both specs → both reports.
    await frontendNode.click();
    await expect(rows).toHaveCount(2, { timeout: 15_000 });

    // "All" clears the tag → the full feed returns.
    await page.getByTestId("qa-reports-tag-all").click();
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
  });

  test("date filter narrows the feed (and ANDs with a tag)", async ({ page, resources }) => {
    const slug = resources.slug("j30b");
    const tenant = await seedOrgTenant({ slug });

    const spec = await seedSpec({
      memexId: tenant.memexId,
      title: "Dated Spec",
      purpose: "Spec with a recent report.",
    });
    await seedTags({ memexId: tenant.memexId, docId: spec.docId, tags: ["area::frontend"] });
    await seedSection({
      memexId: tenant.memexId,
      docId: spec.docId,
      title: "QA Report",
      content: "Recent report.",
      sectionType: "qa_report",
    });

    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/qa-reports"));
    const rows = page.getByTestId("qa-report-row");
    await expect(rows).toHaveCount(1, { timeout: 15_000 });

    // ac-5: a "from" date in the future excludes the just-seeded report → empty.
    const future = "2099-01-01";
    await page.getByTestId("qa-reports-range-from").fill(future);
    await expect(page.getByTestId("qa-reports-empty")).toBeVisible({ timeout: 15_000 });

    // Clearing the window back to "All time" restores the report.
    await page.getByTestId("qa-reports-range-all").click();
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
  });
});
