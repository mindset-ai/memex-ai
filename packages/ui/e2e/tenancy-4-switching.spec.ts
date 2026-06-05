// spec-172 ac-5 (tenancy flow 4 of 6) — multi-org/memex switching, written fresh
// against the current UI per dec-1.
//
// Dev is a member of two orgs. The MemexSwitcher lists both under their
// namespaces ("Your orgs"); clicking a Memex navigates by PATH via React Router
// on the same origin [per std-2] and lands on that tenant's /specs board. There
// is no subdomain hop — navigation is a client-side route change.

import {
  test,
  expect,
  tenantPath,
  DEV_EMAIL,
  setUserName,
  seedOrg,
  emitAcEvents,
} from "./helpers/index.js";

const AC5 = ["mindset-prod/memex-building-itself/specs/spec-172/acs/ac-5"];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    AC5,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/tenancy-4-switching.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("a user in two orgs switches between them via the MemexSwitcher (path nav)", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");

  // Two orgs, dev admin of both, with DISTINCT memex names so the switcher rows
  // are unambiguous (both default to slug "main").
  const slugA = resources.slug("tenancy-swa");
  const slugB = resources.slug("tenancy-swb");
  const orgA = await seedOrg({
    ownerEmail: DEV_EMAIL,
    slug: slugA,
    name: "Switch Org A",
    memexName: "Alpha Memex",
  });
  const orgB = await seedOrg({
    ownerEmail: DEV_EMAIL,
    slug: slugB,
    name: "Switch Org B",
    memexName: "Beta Memex",
  });

  // Start on org A's Specs board.
  await page.goto(tenantPath(slugA, orgA.memexSlug, "/specs"), { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
    timeout: 15_000,
  });

  // Open the switcher — both orgs appear under "Your orgs". Scope assertions to
  // the dropdown menu: the CURRENT memex's name (Alpha Memex) also renders in the
  // switcher TRIGGER, so an unscoped getByText would strict-mode double-match.
  await page.getByTitle("Switch Memex").first().click();
  const menu = page.getByTestId("memex-switcher-menu");
  await expect(menu.getByText("Your orgs")).toBeVisible({ timeout: 10_000 });
  await expect(menu.getByText("Alpha Memex")).toBeVisible();
  await expect(menu.getByText("Beta Memex")).toBeVisible();

  // Click into org B's Memex — React Router same-origin navigation to /specs.
  await menu.getByText("Beta Memex").click();
  await page.waitForURL(
    (url) => url.pathname === `/${slugB}/${orgB.memexSlug}/specs`,
    { timeout: 15_000 },
  );
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
    timeout: 15_000,
  });

  // Switch back to org A the same way to prove it's bidirectional, not a one-shot.
  await page.getByTitle("Switch Memex").first().click();
  await page.getByTestId("memex-switcher-menu").getByText("Alpha Memex").click();
  await page.waitForURL(
    (url) => url.pathname === `/${slugA}/${orgA.memexSlug}/specs`,
    { timeout: 15_000 },
  );
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
    timeout: 15_000,
  });
});
