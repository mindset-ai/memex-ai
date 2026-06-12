// Journey 29 — Web-UI phase moves: the Done tab + the editor override (spec-258,
// std-28 PR-gate journey). The two user-facing flows surfaced by spec-164/issue-3
// (Will, prod spec-61): a finished spec sat in verify with NO human path to close,
// and a blocked forward move offered an editor nothing on the current tab.
//
//   1. CLOSE VIA THE DONE TAB — a human editor takes a clean verify spec, clicks
//      the new Done tab (the pipeline now reads Specify → Build → Verify → Done),
//      sees the read-only DoneSummary preview + the browse-confirm Rubicon
//      ("Are you sure you want to move this spec to Done?"), confirms, and the
//      page collapses into the done report. No in-app agent, no MCP. (ac-1/2/3/4/5)
//   2. OVERRIDE A BLOCKED MOVE — on a blocked current tab (build with an
//      incomplete task), the editor gets the dec-5 "Move this spec to Verify
//      anyway?" override and forces the move the kanban already allows. (ac-8)
//
// Seeding is HTTP-only over the __test__ surface (spec-172 dec-2): seed-org,
// seed-spec, set-doc-status, seed-ac, seed-test-event, seed-task. Navigation is
// path-based [per std-2]. A seeded spec has no editor doc_member, so the dev
// opens it as a REVIEWER — switchToEditing promotes before driving the
// editor-gated affordances.

import {
  test,
  expect,
  tenantPath,
  switchToEditing,
  seedAc,
  seedTestEvent,
  seedTask,
  emitAcEvents,
} from "./helpers/index.js";
import { seedOrgTenant, seedSpec, setDocStatus } from "./helpers/retained.js";

const SPEC258 = "mindset-prod/memex-building-itself/specs/spec-258";

const ACS_BY_TEST: Record<string, string[]> = {
  "close via the Done tab: a human editor closes a clean verify spec, no agent/MCP": [
    `${SPEC258}/acs/ac-1`,
    `${SPEC258}/acs/ac-2`,
    `${SPEC258}/acs/ac-3`,
    `${SPEC258}/acs/ac-4`,
    `${SPEC258}/acs/ac-5`,
  ],
  "editor override: a blocked forward move offers 'Move … anyway?' and forces it": [
    `${SPEC258}/acs/ac-8`,
  ],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TEST[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-29-spec-258-done-tab.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

test("close via the Done tab: a human editor closes a clean verify spec, no agent/MCP", async ({
  page,
  resources,
}) => {
  // ── Seed a verify-phase spec whose single AC is verified → a CLEAN verify
  //    rubric (the finished-spec state issue-3 is about). ─────────────────────
  const tenant = await seedOrgTenant({ slug: resources.slug("j29a") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Done-tab close journey",
    purpose: "A finished spec with no path to close — until the Done tab.",
  });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "verify" });
  const ac = await seedAc({
    memexId: tenant.memexId,
    docId: spec.docId,
    kind: "scope",
    statement: "The close flow is reachable by a human.",
  });
  expect(ac.acUid, "seeded AC should carry a canonical acUid").not.toBeNull();
  // A passing emission flips the AC to `verified` → unverifiedAcCount 0 → the
  // verify→done rubric is clean, so the Done tab offers the ready confirm.
  await seedTestEvent({ acUid: ac.acUid!, status: "pass", testIdentifier: "j29-seed" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" }
  );
  await expect(
    page.getByRole("heading", { level: 1, name: /Done-tab close journey/ })
  ).toBeVisible({ timeout: 15_000 });
  await switchToEditing(page);

  // ── ac-1: the pipeline completes Specify → Build → Verify → Done. ──────────
  await expect(page.locator('[role="tab"][data-tab="verify"][data-current="true"]')).toBeVisible({
    timeout: 15_000,
  });
  const doneTab = page.locator('[role="tab"][data-tab="done"]');
  await expect(doneTab).toBeVisible();
  // dec-4: the Done tab is never the filled "current" pill while the bar is shown.
  await expect(doneTab).not.toHaveAttribute("data-current", "true");

  // ── ac-4: browsing Done previews the read-only DoneSummary (no Reopen). ────
  await doneTab.click();
  await expect(page.getByTestId("done-summary")).toBeVisible({ timeout: 15_000 });
  // The preview carries NO Reopen affordance — that belongs to the post-close report.
  await expect(page.getByTestId("done-reopen")).toHaveCount(0);

  // ── ac-2 (ready): the browse-confirm Rubicon offers the move. ─────────────
  const sentence = page.getByTestId("transition-sentence");
  await expect(sentence).toContainText(/Are you sure you want to move this spec to Done\?/i);

  // ── ac-3 / ac-5: confirm → the spec closes and the page collapses into the
  //    done report (with its Reopen door); the tab bar is gone. ──────────────
  await sentence.getByRole("button", { name: /^Yes$/ }).click();
  await expect(page.getByTestId("done-reopen")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[role="tab"]')).toHaveCount(0);
  await expect(page.getByTestId("done-summary")).toBeVisible();
});

test("editor override: a blocked forward move offers 'Move … anyway?' and forces it", async ({
  page,
  resources,
}) => {
  // ── Seed a BUILD-phase spec with an incomplete task → the build→verify rubric
  //    blocks (open task), so the current Build tab is the button-less blocked
  //    state — until the dec-5 editor override. ───────────────────────────────
  const tenant = await seedOrgTenant({ slug: resources.slug("j29b") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Blocked-move override journey",
    purpose: "A blocked forward move an editor can still force from the spec page.",
  });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "build" });
  await seedTask({
    memexId: tenant.memexId,
    docId: spec.docId,
    title: "Still in flight",
    status: "in_progress",
  });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" }
  );
  await expect(
    page.getByRole("heading", { level: 1, name: /Blocked-move override journey/ })
  ).toBeVisible({ timeout: 15_000 });
  await switchToEditing(page);

  // ── ac-8: the blocked current tab names what's open AND offers the editor the
  //    "Move this spec to Verify anyway?" override. ───────────────────────────
  const sentence = page.getByTestId("transition-sentence");
  await expect(sentence).toContainText(
    /Task must be completed[\s\S]*before this spec can move to Verify/i,
    { timeout: 15_000 }
  );
  await expect(sentence).toContainText(/Move this spec to Verify anyway\?/i);

  // Forcing it advances the spec the kanban already permits (soft gates).
  await sentence.getByRole("button", { name: /^Yes$/ }).click();
  await expect(
    page.locator('[role="tab"][data-tab="verify"][data-current="true"]')
  ).toBeVisible({ timeout: 15_000 });
});
