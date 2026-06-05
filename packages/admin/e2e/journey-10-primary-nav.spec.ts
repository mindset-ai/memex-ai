import { test, expect, bareUrl } from "./helpers/fixtures.js";

// Journey 10 (t-14): top-level navigation reorg per dec-25.
// The header's primary nav exposes four entry points — Specs, Standards,
// Documents, Installation — and each link routes the user to the matching list
// page. The active link picks up the heading-color treatment so users can tell
// where they are.

test("primary nav routes to all four list pages", async ({ page }) => {
  await page.goto(bareUrl("/"));

  // Bare-domain landing should auto-resolve to Specs (per the App.tsx
  // fallback route). Wait for Specs to be active before clicking around.
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
    timeout: 15_000,
  });

  const nav = page.getByTestId("primary-nav");
  await expect(nav).toBeVisible();

  // Specs link is rendered + clickable
  await expect(nav.getByRole("link", { name: "Specs" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Standards" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Documents" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Installation" })).toBeVisible();

  // Standards
  await nav.getByRole("link", { name: "Standards" }).click();
  await expect(page).toHaveURL(/\/standards$/);
  await expect(page.getByRole("heading", { name: "Standards" })).toBeVisible();

  // Documents
  await nav.getByRole("link", { name: "Documents" }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();

  // Installation
  await nav.getByRole("link", { name: "Installation" }).click();
  await expect(page).toHaveURL(/\/install(ation)?$/);

  // Back to Specs
  await nav.getByRole("link", { name: "Specs" }).click();
  await expect(page).toHaveURL(/\/specs$/);
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible();
});

test("primary nav is hidden when viewing a single document", async ({ page }) => {
  await page.goto(bareUrl("/"));
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
    timeout: 15_000,
  });

  // Find the first spec card. If none exist (clean local DB) skip the
  // single-doc verification — we just need a doc to exist for that branch and
  // adding test fixtures here is overkill.
  const firstSpec = page.locator('a[href^="/docs/doc-"]').first();
  const hasSpec = await firstSpec.count();
  if (hasSpec === 0) {
    test.skip(true, "No specs in local DB — skip the doc-page nav check.");
  }

  await firstSpec.click();
  await expect(page).toHaveURL(/\/docs\/doc-\d+$/);
  // Primary nav hides on the doc page; the "All specs" back link replaces it.
  await expect(page.getByTestId("primary-nav")).not.toBeVisible();
  await expect(page.getByRole("link", { name: /All specs/i })).toBeVisible();
});
