import { test, expect, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, seedUser, seedMembership, countAdmins } from "./helpers/db.js";

// Journey 6: Member Management
// Admin views users list, promotes a user to admin, demotes them back, disables them.
// Dev-mode: uses dev@memex.ai as the admin + seeded peer users for other actions.
// Real-time auth switching between users isn't possible here (dev bypass has only one user),
// so actions TARGET other users via their UUID rather than LOGIN AS them.

test("admin manages users: promote, demote, disable", async ({ page, resources }) => {
  const subdomain = resources.subdomain("j6");
  const accountId = await seedAccount({ subdomain, name: "Member Mgmt" });
  resources.accountIds.push(accountId);
  await resources.devAsAdmin(accountId);

  // Seed a peer user
  const peerEmail = resources.email("peer");
  const peerId = await seedUser(peerEmail);
  await seedMembership(peerId, accountId, "user");

  await page.goto(tenantUrl(subdomain, "/account?tab=users"));

  const peerRow = () => page.locator(`[data-testid="member-row"][data-email="${peerEmail}"]`);

  // Member list shows peer
  await expect(peerRow()).toBeVisible({ timeout: 10_000 });

  // Promote the peer
  await peerRow().getByRole("button", { name: /Promote/i }).click();
  await expect
    .poll(() => countAdmins(accountId), { timeout: 5000 })
    .toBe(2); // dev + peer

  // Demote the peer
  await peerRow().getByRole("button", { name: /Demote/i }).click();
  await expect
    .poll(() => countAdmins(accountId), { timeout: 5000 })
    .toBe(1); // just dev again

  // Disable the peer
  await peerRow().getByRole("button", { name: /Remove/i }).click();
  // Peer still appears in the list but flagged (Inactive) — server keeps the row with status=disabled
  await expect(page.getByText(`${peerEmail} (Inactive)`)).toBeVisible({ timeout: 5000 });
});
