import {
  test,
  expect,
  tenantPath,
  bareUrl,
  DEV_EMAIL,
  seedOrg,
  emitAcEvents,
} from "./helpers/index.js";

// Journey 62 — spec-481: rename a NAMESPACE slug from /:namespace/settings, and
// prove old links under the namespace forward to the new slug (std-28 gate).
//
// Emits:
//   ac-1 — an admin renames the namespace slug from a web UI surface (org namespace)
//   ac-4 — the /:namespace/settings page gates on live availability, states its
//          consequences before commit, then navigates to the new /<new-ns>/ home
//   ac-2 — a previously-valid DEEP tenant URL under the OLD namespace slug forwards
//          to its new-slug equivalent in the browser (TenantLayout stale-forward)

const AC = [
  "mindset-prod/memex-building-itself/specs/spec-481/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-481/acs/ac-2",
  "mindset-prod/memex-building-itself/specs/spec-481/acs/ac-4",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-62-spec-481-namespace-rename.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("admin renames the namespace slug from Settings; old deep links forward (ac-1, ac-2, ac-4)", async ({
  page,
  resources,
}) => {
  const oldNs = resources.slug("rename-ns");
  const newNs = resources.slug("rename-ns-new");
  await seedOrg({
    ownerEmail: DEV_EMAIL,
    slug: oldNs,
    memexSlug: "workspace",
    memexName: "Workspace",
  });

  // ── The settings surface renders for the admin. ──
  await page.goto(bareUrl(`/${oldNs}/settings`));
  const section = page.getByTestId("namespace-rename");
  await expect(section).toBeVisible();

  // ── Slug: change → live availability clears → confirm consequences →
  //    navigate to the new /<new-ns>/ home. ──
  await page.getByTestId("namespace-slug-input").fill(newNs);
  const renameBtn = page.getByTestId("namespace-slug-rename");
  await expect(renameBtn).toBeEnabled(); // enables once the debounced check reports free
  await renameBtn.click();

  // ac-4: the confirm names the consequence (old links forward) BEFORE commit.
  const confirm = page.getByTestId("namespace-slug-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("forward");
  await page.getByTestId("namespace-slug-confirm-btn").click();

  // ac-1 slug half: navigates to the new /<new-ns>/ home.
  await expect(page).toHaveURL(bareUrl(`/${newNs}`));

  // ac-2: a bookmarked OLD deep tenant URL forwards to the new-slug equivalent
  // in the browser. The namespace_rename redirect is a 1-segment prefix, so the
  // resolver rewrites every descendant path from it.
  await page.goto(tenantPath(oldNs, "workspace", "/specs"));
  await expect(page).toHaveURL(tenantPath(newNs, "workspace", "/specs"));
});
