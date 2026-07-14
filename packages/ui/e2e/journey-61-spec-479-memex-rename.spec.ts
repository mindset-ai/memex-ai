import {
  test,
  expect,
  tenantPath,
  DEV_EMAIL,
  setUserName,
  seedOrg,
  emitAcEvents,
} from "./helpers/index.js";

// Journey 61 — spec-479: rename a Memex (display name + URL slug) from the
// per-Memex settings page (std-28 gate).
//
// Emits:
//   ac-1 — an admin renames the display name AND the URL slug from the settings page
//   ac-4 — the slug rename states its consequences before commit; the name change does not
//   ac-7 — the settings page renders the rename section; a slug change navigates to the new URL
//   ac-11 — a bookmarked OLD tenant page URL forwards to the new one in the browser
//           (dec-5: TenantLayout consults GET /api/redirects/resolve on a miss)

const AC = [
  "mindset-prod/memex-building-itself/specs/spec-479/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-479/acs/ac-4",
  "mindset-prod/memex-building-itself/specs/spec-479/acs/ac-7",
  // ac-11 (dec-5): the stale-tenant page URL forwards in the browser.
  "mindset-prod/memex-building-itself/specs/spec-479/acs/ac-11",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-61-spec-479-memex-rename.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("admin renames the Memex display name and URL slug from Settings (ac-1, ac-4, ac-7)", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");
  const org = await seedOrg({
    ownerEmail: DEV_EMAIL,
    slug: resources.slug("rename-org"),
    memexSlug: "workspace",
    memexName: "Workspace",
  });

  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/settings"));

  const section = page.getByTestId("memex-rename");
  await expect(section).toBeVisible();

  // ── Display name: saves immediately, no confirm (ac-1 name half; ac-4 — a
  //    name change shows no consequence warnings). ──
  await page.getByTestId("memex-name-input").fill("Renamed Workspace");
  await page.getByTestId("memex-name-save").click();
  await expect(page.getByText("Name saved.")).toBeVisible();
  // No slug confirm appeared for a name-only change.
  await expect(page.getByTestId("memex-slug-confirm")).toHaveCount(0);

  // ── URL slug: change → live availability clears → confirm consequences →
  //    navigate to the new URL. ──
  await page.getByTestId("memex-slug-input").fill("workspace-renamed");
  const renameBtn = page.getByTestId("memex-slug-rename");
  // Enables only once the debounced availability check reports the slug free.
  await expect(renameBtn).toBeEnabled();
  await renameBtn.click();

  // ac-4: the confirm names the consequence (old links forward) BEFORE commit.
  const confirm = page.getByTestId("memex-slug-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("forward");
  await page.getByTestId("memex-slug-confirm-btn").click();

  // ac-7 / ac-1 slug half: the page navigates to the new /<ns>/<new-slug>/settings
  // URL and the settings surface renders there.
  await expect(page).toHaveURL(
    tenantPath(org.namespaceSlug, "workspace-renamed", "/settings"),
  );
  await expect(page.getByTestId("memex-rename")).toBeVisible();

  // ac-11 (dec-5): a bookmarked OLD url forwards to the new one in the browser.
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/settings"));
  await expect(page).toHaveURL(
    tenantPath(org.namespaceSlug, "workspace-renamed", "/settings"),
  );
});
