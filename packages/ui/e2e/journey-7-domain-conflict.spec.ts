import { test, expect, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, setAccountDomainVerified } from "./helpers/db.js";

// Journey 7: Domain Verification & Conflict
// Two accounts try to claim the same domain. The first to verify wins — the second sees a
// conflict error at verify-initiate time.

test("second account cannot claim an already-verified domain", async ({ page, resources }) => {
  const domain = `${resources.uniq}.test`;
  const subA = resources.subdomain("j7a");
  const subB = resources.subdomain("j7b");

  const accA = await seedAccount({ subdomain: subA, emailDomains: [domain] });
  const accB = await seedAccount({ subdomain: subB, emailDomains: [domain] });
  resources.accountIds.push(accA, accB);

  // Account A already verified the domain
  await setAccountDomainVerified(accA, domain);

  // dev user acts as admin of B (the losing side)
  const { seedUser, seedMembership } = await import("./helpers/db.js");
  const devId = await seedUser("dev@memex.ai");
  await seedMembership(devId, accB, "administrator");

  await page.goto(tenantUrl(subB, "/account?tab=settings"));
  await expect(page.getByText(domain).first()).toBeVisible({ timeout: 10_000 });

  // Click "Verify via email" — should surface a conflict error from the server (409)
  await page.getByRole("button", { name: /Verify via email/i }).click();

  // The settings UI shows the error via its inline error banner. Depending on the response
  // shape the admin client surfaces either the `error` or `message` field.
  await expect(
    page.getByText(/already verified by another account|Conflict/i)
  ).toBeVisible({ timeout: 5000 });
});
