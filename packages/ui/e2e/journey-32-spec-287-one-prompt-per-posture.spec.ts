import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, setDocStatus } from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/emit-ac.js";

// Journey 32 (spec-287): one coding-agent prompt per posture in Specify.
//
// On a Specify-phase Spec the page offers exactly ONE handoff prompt, keyed to
// the viewer's posture (dec-2):
//   • reviewer (and read-only) → the Review handoff ("Copy the Review prompt")
//   • editor                   → the phase handoff ("Copy the Specify prompt")
// Neither posture sees both. The review link is Title Case (dec-1). A freshly
// seeded Spec is viewed in the default REVIEWING posture; promoting via the
// PostureDropdown pill flips which single prompt shows.

const SPEC287 = "mindset-prod/memex-building-itself/specs/spec-287";

const ACS_BY_TEST: Record<string, string[]> = {
  "one coding-agent prompt per posture in Specify": [
    `${SPEC287}/acs/ac-1`, // editor sees the Specify prompt only
    `${SPEC287}/acs/ac-2`, // reviewer sees the Review prompt only
    `${SPEC287}/acs/ac-3`, // the review link is Title Case
    `${SPEC287}/acs/ac-5`, // per-posture single-prompt rule, shipped with an e2e journey
    `${SPEC287}/acs/ac-6`, // std-28 journey asserts editor→Specify-only, reviewer→Review-only
  ],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TEST[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-32-spec-287-one-prompt-per-posture.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

test("one coding-agent prompt per posture in Specify", async ({ page, resources }) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j32") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "One prompt per posture",
    purpose: "Exercise the per-posture single-prompt handoff in Specify.",
  });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "specify" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`)
  );

  // The agent panel heading is the reliable page-load anchor (per journey-31).
  await expect(page.getByText("Spec assistant")).toBeVisible({ timeout: 15_000 });

  // ── Default REVIEWING posture: the Review handoff shows, the Specify
  //    phase handoff does NOT (ac-2). The link is Title Case (ac-3). ──
  await expect(page.getByRole("button", { name: /You are reviewing/i })).toBeVisible({
    timeout: 15_000,
  });
  const reviewLine = page.getByTestId("review-handoff-line");
  await expect(reviewLine).toBeVisible({ timeout: 15_000 });
  await expect(reviewLine).toContainText("Copy the Review prompt");
  await expect(page.getByTestId("phase-handoff-line")).toHaveCount(0);

  // ── Promote to EDITING via the PostureDropdown pill ──
  await page.getByRole("button", { name: /You are reviewing/i }).click();
  await page.getByRole("menuitemradio", { name: /Editing/i }).click();
  await expect(page.getByRole("button", { name: /You are editing/i })).toBeVisible({
    timeout: 15_000,
  });

  // ── Editor posture: the Specify phase handoff shows, the Review handoff
  //    does NOT (ac-1). One prompt per posture. ──
  const phaseLine = page.getByTestId("phase-handoff-line");
  await expect(phaseLine).toBeVisible({ timeout: 15_000 });
  await expect(phaseLine).toContainText("Copy the Specify prompt");
  await expect(page.getByTestId("review-handoff-line")).toHaveCount(0);
});
