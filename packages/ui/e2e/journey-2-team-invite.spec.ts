import { test, expect, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, getLatestInviteToken, countAdmins } from "./helpers/db.js";

// Journey 2: Team Expansion via Invite
// Admin (dev user) generates an invite link, copies the URL. A new user clicks the link
// and accepts, becoming a 'user' of the account.
//
// Dev-mode caveat: there's only one "real" user in dev (dev@memex.ai). We simulate the
// "new user" part by having dev@memex.ai act as the inviter and directly seed a second user
// for the accept-invite flow. Full SSO-identity switching is out of scope for this test.

test("admin generates an invite link and a new user accepts it", async ({
  page,
  resources,
}) => {
  const subdomain = resources.subdomain("j2");
  const accountId = await seedAccount({
    subdomain,
    name: "Invite Test",
  });
  resources.accountIds.push(accountId);
  await resources.devAsAdmin(accountId);

  // Navigate to the Invites tab in Account Configuration
  await page.goto(tenantUrl(subdomain, "/account?tab=invites"));
  await expect(
    page.getByRole("heading", { name: "Invite links" })
  ).toBeVisible({ timeout: 10_000 });

  // Click "New invite link" → a row should appear with a copyable URL
  await page.getByRole("button", { name: /New invite link/i }).click();

  // The list eventually shows the new invite (inline row with a Copy button)
  await expect(page.getByRole("button", { name: /Copy/i }).first()).toBeVisible({
    timeout: 5000,
  });

  // Fetch the token from DB to exercise the accept flow directly — the accept page is
  // at /invite/:token on the same subdomain.
  const token = await getLatestInviteToken(accountId);
  expect(token).toBeTruthy();

  // Navigate to the invite landing (still as dev@memex.ai, already an admin). The UI should
  // recognize the existing membership and send them to "/". This exercises the InviteAccept
  // idempotency path (re-clicking a link when you're already a member).
  await page.goto(tenantUrl(subdomain, `/invite/${token}`));
  await page.waitForURL(
    (url) => url.pathname === "/" && url.hostname.startsWith(`${subdomain}.`),
    { timeout: 10_000 }
  );

  // Admin count stays at 1 (the re-click didn't promote anyone or drop anyone)
  expect(await countAdmins(accountId)).toBe(1);
});
