import { test, expect, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, setAccountDomainVerified, getAccountById } from "./helpers/db.js";

// Journey 3: Auto-Grouping Setup & Activation
// Admin enables auto-grouping in Settings → adds domain → (simulate) domain verification →
// account.auto_grouping_enabled + domain_verified both true.
//
// The email verification click-through is a separate flow (t-6) tested elsewhere; here we
// seed the verified_domains row and confirm the UI reflects it.

test("admin enables auto-grouping with a verified domain", async ({ page, resources }) => {
  const subdomain = resources.subdomain("j3");
  const domain = `${resources.uniq}.test`;
  const accountId = await seedAccount({
    subdomain,
    name: "Auto-Group Test",
    emailDomains: [domain],
  });
  resources.accountIds.push(accountId);
  await resources.devAsAdmin(accountId);
  await setAccountDomainVerified(accountId, domain);

  // Visit the Settings tab
  await page.goto(tenantUrl(subdomain, "/account?tab=settings"));

  // The domain should render with "verified (email)" badge
  await expect(page.getByText(domain).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/verified \(email\)/i)).toBeVisible({ timeout: 5000 });

  // Toggle auto-grouping on. The input is a controlled component whose `checked` value only
  // flips after the PATCH returns and the summary refreshes, so `check()`'s synchronous
  // state-change assertion is unreliable — we `click()` and poll the DB instead.
  await page.getByRole("checkbox").click();
  await expect
    .poll(async () => (await getAccountById(accountId))?.auto_grouping_enabled, {
      timeout: 5000,
    })
    .toBe(true);

  const after = await getAccountById(accountId);
  expect(after?.domain_verified).toBe(true);
});
