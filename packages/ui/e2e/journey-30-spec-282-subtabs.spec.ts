// Journey 30 — One persistent sub-tab control + a browse-only advance offer
// (spec-282, std-28 PR-gate journey). Covers the two user-facing flows:
//
//   1. PERSISTENT SUB-TABS — one control carries the same five tabs (Narrative ·
//      Comments · Decisions & ACs · Agent Tasks & Issues · QA Report) in every
//      phase view; Narrative & Comments stay reachable in Build and Verify
//      (accretion never removes an earlier tab), and the QA Report tab shows an
//      honest empty-state placeholder before a report exists. (ac-1/2/3/7)
//   2. BROWSE-ONLY ADVANCE — on the current phase tab there is NO advance
//      question or [Yes] button (status-only); the advance confirm appears only
//      when browsing a non-current phase tab, where the editor can still force a
//      blocked forward move. (ac-5/6/7)
//
// Seeding is HTTP-only over the __test__ surface (spec-172 dec-2): seed-org,
// seed-spec, set-doc-status. Navigation is path-based [per std-2]. A seeded spec
// opens as a REVIEWER, so switchToEditing promotes before the editor-gated
// advance affordances are exercised.

import {
  test,
  expect,
  tenantPath,
  switchToEditing,
  emitAcEvents,
} from "./helpers/index.js";
import { seedOrgTenant, seedSpec, setDocStatus } from "./helpers/retained.js";

const SPEC282 = "mindset-prod/memex-building-itself/specs/spec-282";

const SUB_TABS = [
  "Narrative",
  "Comments",
  "Decisions & ACs",
  "Agent Tasks & Issues",
  "QA Report",
];

const ACS_BY_TEST: Record<string, string[]> = {
  "one persistent sub-tab control: the same five tabs in every phase; QA Report placeholder": [
    `${SPEC282}/acs/ac-1`,
    `${SPEC282}/acs/ac-2`,
    `${SPEC282}/acs/ac-3`,
    `${SPEC282}/acs/ac-7`,
  ],
  "browse-only advance: no offer on the current tab; the confirm appears only when browsing forward": [
    `${SPEC282}/acs/ac-5`,
    `${SPEC282}/acs/ac-6`,
    `${SPEC282}/acs/ac-7`,
  ],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TEST[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-30-spec-282-subtabs.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

// Every sub-tab button is present (and therefore reachable) in the current view.
async function expectAllSubTabs(page: import("@playwright/test").Page) {
  for (const label of SUB_TABS) {
    await expect(
      page.getByRole("button", { name: new RegExp(`^${label}\\b`) })
    ).toBeVisible({ timeout: 15_000 });
  }
}

test("one persistent sub-tab control: the same five tabs in every phase; QA Report placeholder", async ({
  page,
  resources,
}) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j30a") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Persistent sub-tabs journey",
    purpose: "One control, every phase.",
  });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "build" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" }
  );
  await expect(
    page.getByRole("heading", { level: 1, name: /Persistent sub-tabs journey/ })
  ).toBeVisible({ timeout: 15_000 });

  // ── ac-1/ac-2: Build view shows all five sub-tabs; it lands on Decisions & ACs. ──
  await expect(
    page.locator('[role="tab"][data-tab="build"][data-current="true"]')
  ).toBeVisible({ timeout: 15_000 });
  await expectAllSubTabs(page);

  // ── ac-3: the QA Report tab shows its honest empty-state placeholder. ──
  await page.getByRole("button", { name: /^QA Report\b/ }).click();
  await expect(page.getByTestId("qa-report-empty")).toContainText(
    "No QA report yet — generated when build hands off to verify"
  );

  // ── ac-2: browse Specify — the same five tabs persist (Narrative & Comments
  //    remain present, so the control is never swapped out). ──
  await page.locator('[role="tab"][data-tab="specify"]').click();
  await expectAllSubTabs(page);

  // ── ac-2: browse Verify — still all five tabs; an earlier-phase tab
  //    (Narrative) is still reachable and renders its content. ──
  await page.locator('[role="tab"][data-tab="verify"]').click();
  await expectAllSubTabs(page);
  await page.getByRole("button", { name: /^Narrative\b/ }).click();
  await expect(page.getByText("Segments", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

test("browse-only advance: no offer on the current tab; the confirm appears only when browsing forward", async ({
  page,
  resources,
}) => {
  // A build-phase spec with NO tasks → the build→verify rubric blocks.
  const tenant = await seedOrgTenant({ slug: resources.slug("j30b") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Browse-only advance journey",
    purpose: "The advance offer lives on the browse-forward confirm only.",
  });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "build" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" }
  );
  await expect(
    page.getByRole("heading", { level: 1, name: /Browse-only advance journey/ })
  ).toBeVisible({ timeout: 15_000 });
  await switchToEditing(page);

  // ── ac-5: on the current Build tab the line is STATUS-ONLY — it names the
  //    open rubric work but carries NO advance question and NO button. ──
  const sentence = page.getByTestId("transition-sentence");
  await expect(sentence).toContainText(
    /Tasks must be created and completed[\s\S]*before this spec can move to Verify/i,
    { timeout: 15_000 }
  );
  await expect(sentence).not.toContainText(/anyway\?/i);
  await expect(sentence).not.toContainText(/Do you (want|wish)/i);
  await expect(sentence.getByRole("button", { name: /^Yes$/ })).toHaveCount(0);

  // ── ac-6: browsing the (non-current) Verify tab surfaces the advance confirm
  //    — the editor's force-forward path: "Move this spec anyway?" [Yes] [No]. ──
  await page.locator('[role="tab"][data-tab="verify"]').click();
  await expect(sentence).toContainText(/Move this spec anyway\?/i, { timeout: 15_000 });
  await expect(sentence.getByRole("button", { name: /^Yes$/ })).toHaveCount(1);
  await expect(sentence.getByRole("button", { name: /^No$/ })).toHaveCount(1);

  // [No] returns to the current tab without mutating the phase.
  await sentence.getByRole("button", { name: /^No$/ }).click();
  await expect(
    page.locator('[role="tab"][data-tab="build"][data-current="true"]')
  ).toBeVisible();
});
