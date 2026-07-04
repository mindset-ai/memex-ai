import {
  test,
  expect,
  tenantPath,
  ensureUser,
  seedAssignee,
  emitAcEvents,
} from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";

// Journey 54 (spec-447): the assignee filter on the Specs board must survive the
// round-trip into a spec and back via the "← All specs" header link. The filter
// lives in the URL (spec-118 ac-19), but that header link navigates to a BARE
// /specs (resolveNavTo drops the query string), so returning that way used to
// reset the board to "All". The fix remembers the filter per-tenant and restores
// it on mount. This journey proves the user-visible outcome (ac-1): apply the
// filter, open a spec, click "← All specs", and the board is still filtered.
//
// Path-based nav [per std-2]; HTTP-only seeding via the env-gated test surface
// (no raw SQL) [per std-28].

const SPEC = "mindset-prod/memex-building-itself/specs/spec-447";

// AC emission per the ac-emission discipline (mirrors journey-24): emit on
// pass AND fail. First hook arg destructured ({}) as Playwright requires.
const ACS_BY_TEST: Record<string, string[]> = {
  'assignee filter survives opening a spec and returning via "← All specs" (ac-1)':
    [`${SPEC}/acs/ac-1`],
  'an active filter is visible on the board and "Clear filters" resets it (ac-7, ac-8)':
    [`${SPEC}/acs/ac-7`, `${SPEC}/acs/ac-8`],
};
test.afterEach(async ({}, testInfo) => {
  const acRefs = ACS_BY_TEST[testInfo.title] ?? [];
  if (acRefs.length === 0) return;
  await emitAcEvents(
    acRefs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-54-spec-447-assignee-filter-persistence.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test('assignee filter survives opening a spec and returning via "← All specs" (ac-1)', async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j54");
  const tenant = await seedOrgTenant({ slug });
  const devUserId = await ensureUser("dev@memex.ai");

  // One spec assigned to me, one not — so "Assigned to me" narrows the board.
  const mine = await seedSpec({
    memexId: tenant.memexId,
    title: "Alpha assigned to me",
    purpose: "This one is mine.",
  });
  await seedAssignee({ memexId: tenant.memexId, docId: mine.docId, userId: devUserId });
  await seedSpec({
    memexId: tenant.memexId,
    title: "Beta not mine",
    purpose: "This one is not mine.",
  });

  // Board opens unfiltered — both specs visible.
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
  await expect(page.getByText("Alpha assigned to me")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Beta not mine")).toBeVisible();

  // Apply "Assigned to me": only my spec remains, and the filter is in the URL.
  await page.getByLabel("Filter by assignee").selectOption("me");
  await expect(page.getByText("Beta not mine")).not.toBeVisible();
  await expect(page.getByText("Alpha assigned to me")).toBeVisible();
  await expect(page).toHaveURL(/assignee=me/);

  // Open my spec, then return to the board via the "← All specs" header link
  // (the bare-/specs path that used to drop the filter).
  await page.getByText("Alpha assigned to me").click();
  await expect(page).toHaveURL(new RegExp(`/specs/${mine.handle}`));
  await page.getByRole("link", { name: /All specs/ }).click();

  // The filter SURVIVES the round-trip: the board is still narrowed to me,
  // Beta stays hidden, and the filter is still reflected in the URL (shareable).
  await expect(page.getByText("Alpha assigned to me")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Beta not mine")).not.toBeVisible();
  await expect(page).toHaveURL(/assignee=me/);
});

// spec-447 dec-2: a persisted filter must never make a filtered board read as
// unfiltered — the active state has to be visible in the UI (not just the URL),
// and a single "Clear filters" control returns the board to its full view.
test('an active filter is visible on the board and "Clear filters" resets it (ac-7, ac-8)', async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j54c");
  const tenant = await seedOrgTenant({ slug });
  const devUserId = await ensureUser("dev@memex.ai");

  const mine = await seedSpec({
    memexId: tenant.memexId,
    title: "Alpha assigned to me",
    purpose: "This one is mine.",
  });
  await seedAssignee({ memexId: tenant.memexId, docId: mine.docId, userId: devUserId });
  await seedSpec({
    memexId: tenant.memexId,
    title: "Beta not mine",
    purpose: "This one is not mine.",
  });

  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
  await expect(page.getByText("Alpha assigned to me")).toBeVisible({ timeout: 15_000 });

  // Unfiltered: no "Clear filters" affordance and the control is not active.
  const assignee = page.getByLabel("Filter by assignee");
  await expect(assignee).toHaveAttribute("data-active", "false");
  await expect(page.getByTestId("clear-all-filters")).toHaveCount(0);

  // Apply a filter — the board narrows, the control flips to its active state,
  // and the "Clear filters" control appears (the board now reads as filtered).
  await assignee.selectOption("me");
  await expect(page.getByText("Beta not mine")).not.toBeVisible();
  await expect(assignee).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("clear-all-filters")).toBeVisible();

  // One click clears the filter: the full board is restored, the URL drops
  // ?assignee, and the clear control disappears again.
  await page.getByTestId("clear-all-filters").click();
  await expect(page.getByText("Beta not mine")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Alpha assigned to me")).toBeVisible();
  await expect(page).not.toHaveURL(/assignee=/);
  await expect(page.getByTestId("clear-all-filters")).toHaveCount(0);
});
