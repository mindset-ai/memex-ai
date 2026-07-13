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
//
// OUT of scope here (deliberately): browser-level forwarding of a STALE tenant
// PAGE url (part of ac-2). The memex_rename redirect resolves at the
// canonical-ref / API layer — proven by the server service + redirect
// integration tests (renameMemexSlug → lookupRedirect forwards the old path).
// Page-route forwarding for a renamed tenant path is NOT wired in app.ts (only
// the b-N→spec-N regex is), so asserting a browser redirect here would be
// false. Tracked as a follow-up issue.

const AC = [
  "mindset-prod/memex-building-itself/specs/spec-479/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-479/acs/ac-4",
  "mindset-prod/memex-building-itself/specs/spec-479/acs/ac-7",
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
});
