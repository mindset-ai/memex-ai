import { test, expect, bareUrl, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, seedUser, seedMembership } from "./helpers/db.js";

// Journey 4: Multi-account user (GitHub-style model)
// dev@memex.ai has a personal memex (auto-provisioned by the fixture) plus team memberships
// in account A (admin) and account B (user). On the bare domain they land on their personal
// memex; the header switcher lists both teams and lets them jump between.

test("multi-account user lands on personal at root and can switch to teams via the switcher", async ({
  page,
  resources,
}) => {
  const subA = resources.subdomain("j4a");
  const subB = resources.subdomain("j4b");
  const accA = await seedAccount({ subdomain: subA, name: "Acct A" });
  const accB = await seedAccount({ subdomain: subB, name: "Acct B" });
  resources.accountIds.push(accA, accB);

  // dev is admin in A, regular member in B. seedUser provisions a personal memex as well
  // (idempotent — fixture already created it).
  const devId = await seedUser("dev@memex.ai");
  await seedMembership(devId, accA, "administrator");
  await seedMembership(devId, accB, "user");

  // Bare-domain visit → personal memex (not a picker). Switcher label is "Personal Memex".
  await page.goto(bareUrl("/"));
  const switcher = page.getByRole("button", { name: /Personal Memex/i });
  await expect(switcher).toBeVisible({ timeout: 10_000 });

  // Open the dropdown — both teams appear under "Your teams".
  await switcher.click();
  await expect(page.getByText("Acct A")).toBeVisible();
  await expect(page.getByText("Acct B")).toBeVisible();

  // Click Acct A → full-page navigation to subA subdomain root.
  await page.getByText("Acct A").click();
  await page.waitForURL((url) => url.hostname.startsWith(`${subA}.`), { timeout: 10_000 });

  // On team A the switcher now shows "Acct A" and the Team button is visible.
  await expect(
    page.getByRole("button", { name: /Acct A/i }).first()
  ).toBeVisible({ timeout: 10_000 });

  // Direct-navigate to tenant B — PostLoginRouter lets us through since we're a member.
  await page.goto(tenantUrl(subB, "/"));
  await expect(page).toHaveURL(new RegExp(`^https?://${subB}\\.`));
});
