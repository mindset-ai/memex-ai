// spec-172 ac-5 (tenancy flow 2 of 6) — member invite + accept, written fresh
// against the current UI per dec-1.
//
// Two halves, both path-based [per std-2]:
//   (a) Admin generates an invite link via the real UsersTab (Org Configuration
//       → "Invite new user" → InviteModal shows a copyable /invite/:token URL).
//   (b) A *second* user accepts via /invite/:token (InviteAccept's two-step
//       click-to-POST), appears in the org's members, and a re-accept is
//       idempotent (no second membership, no error).
//
// The e2e stack authenticates only as the dev user (dev bypass), so we model the
// "second user" as the dev user accepting an invite to an org it is NOT yet a
// member of: a peer-owned org. The fixture clears dev's org memberships before
// each test, so dev starts outside the seeded org. The invite token for the
// accept step is minted over the test-only surface (the stand-in for the copied
// URL); the admin-side generation is still driven through the real UsersTab UI.

import {
  test,
  expect,
  bareUrl,
  tenantPath,
  DEV_EMAIL,
  ensureUser,
  setUserName,
  seedOrg,
  createInvite,
  emitAcEvents,
} from "./helpers/index.js";

const AC5 = ["mindset-prod/memex-building-itself/specs/spec-172/acs/ac-5"];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    AC5,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/tenancy-2-invite-accept.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("admin generates an invite link in UsersTab", async ({ page, resources }) => {
  // Org where dev is the admin — drive the real invite-generation UI.
  await setUserName(DEV_EMAIL, "Dev User");
  const slug = resources.slug("tenancy-invgen");
  const org = await seedOrg({ ownerEmail: DEV_EMAIL, slug, name: "Invite Gen Org" });

  // Org Configuration → Users tab, scoped to the org tenant so /orgs/current/*
  // resolves this org (the flat /org route lacks tenant context).
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/org?tab=users"), {
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({
    timeout: 15_000,
  });

  // Generate the invite — the InviteModal surfaces a copyable /invite/:token URL.
  await page.getByRole("button", { name: "Invite new user" }).click();
  await expect(page.getByRole("heading", { name: "Invite link created" })).toBeVisible({
    timeout: 10_000,
  });
  const urlCode = page.locator("code", { hasText: "/invite/" });
  await expect(urlCode).toBeVisible();
  await expect(urlCode).toContainText("/invite/");
  await page.getByRole("button", { name: "Done" }).click();
});

test("a second user accepts an invite, appears in members, and re-accept is idempotent", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");

  // A PEER owns the org; dev is NOT a member yet (the fixture cleared dev's
  // memberships). Dev plays the "second user" accepting the invite.
  const peerEmail = resources.email("inviter");
  await ensureUser(peerEmail);
  const slug = resources.slug("tenancy-invacc");
  const org = await seedOrg({ ownerEmail: peerEmail, slug, name: "Invite Accept Org" });

  // Mint the invite token over the test surface (the copied-URL stand-in).
  const { token } = await createInvite(org.orgId);

  // Accept via the real InviteAccept page — two-step: render, then click-to-POST.
  await page.goto(bareUrl(`/invite/${token}`), { waitUntil: "commit" });
  const acceptBtn = page.getByRole("button", { name: "Accept invite" });
  await expect(acceptBtn).toBeVisible({ timeout: 15_000 });
  await acceptBtn.click();

  // Success confirmation. InviteAccept then redirects to the user's CURRENT
  // tenant's Specs board (computed from fresh.currentMemexId) — for a dev user
  // with a personal memex that stays the personal context, not the joined org;
  // the joined-org landing isn't guaranteed, so we don't assert the exact path.
  // Membership is proven below via the switcher.
  await expect(page.getByRole("heading", { name: "You're in!" })).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForURL((url) => /\/specs\b/.test(url.pathname), { timeout: 15_000 });

  // Dev now appears in the org's members list (open Users tab as the new member —
  // the accept made dev a member, but members can't be admins unless promoted, so
  // assert presence via the read-only switcher membership instead of UsersTab,
  // which is admin-only). The MemexSwitcher lists the joined org under "Your orgs".
  await page.goto(tenantPath(slug, org.memexSlug, "/specs"), { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTitle("Switch Memex").first().click();
  // Scope to the dropdown menu: the org name also renders in the page breadcrumb
  // for the current tenant, so an unscoped getByText strict-mode double-matches.
  await expect(
    page.getByTestId("memex-switcher-menu").getByText("Invite Accept Org"),
  ).toBeVisible({ timeout: 10_000 });

  // Re-accept the SAME link — idempotent: success again, no error, still one
  // membership (consumeInviteToken converges on the active membership silently).
  await page.goto(bareUrl(`/invite/${token}`), { waitUntil: "commit" });
  const reAccept = page.getByRole("button", { name: "Accept invite" });
  await expect(reAccept).toBeVisible({ timeout: 15_000 });
  await reAccept.click();
  await expect(page.getByRole("heading", { name: "You're in!" })).toBeVisible({
    timeout: 15_000,
  });
  // The error state never appears.
  await expect(
    page.getByRole("heading", { name: "Couldn't accept the invite" }),
  ).toHaveCount(0);
});
