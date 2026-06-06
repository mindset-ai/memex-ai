// spec-172 ac-5 (tenancy flow 5 of 6) — member management, written fresh against
// the current UI per dec-1.
//
// In the real UsersTab (Org Configuration), an admin promotes a peer to admin,
// demotes them back, removes (disables) them, and re-enables them. The
// last-admin invariant surfaces in the UI as a BLOCKED action: the sole active
// admin's Demote button is disabled with the "At least one administrator must
// remain" tooltip. All path-based [per std-2]; the peer is seeded over the
// test-only surface, actions are driven through the live buttons.

import {
  test,
  expect,
  tenantPath,
  DEV_EMAIL,
  ensureUser,
  setUserName,
  seedOrg,
  addOrgMember,
  emitAcEvents,
} from "./helpers/index.js";

const AC5 = ["mindset-prod/memex-building-itself/specs/spec-172/acs/ac-5"];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    AC5,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/tenancy-5-member-management.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("admin promotes, demotes, removes and re-enables a peer member", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");
  const slug = resources.slug("tenancy-mem");
  const org = await seedOrg({ ownerEmail: DEV_EMAIL, slug, name: "Member Mgmt Org" });

  const peerEmail = resources.email("peer");
  await ensureUser(peerEmail);
  await addOrgMember({ orgId: org.orgId, email: peerEmail, role: "member" });

  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/org?tab=users"), {
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({
    timeout: 15_000,
  });

  const peerRow = () =>
    page.locator(`[data-testid="member-row"][data-email="${peerEmail}"]`);
  await expect(peerRow()).toBeVisible({ timeout: 15_000 });

  // Promote → the peer row gains a Demote button (now an admin).
  await peerRow().getByRole("button", { name: "Promote" }).click();
  await expect(peerRow().getByRole("button", { name: "Demote" })).toBeVisible({
    timeout: 10_000,
  });

  // Demote → back to a member (Promote returns).
  await peerRow().getByRole("button", { name: "Demote" }).click();
  await expect(peerRow().getByRole("button", { name: "Promote" })).toBeVisible({
    timeout: 10_000,
  });

  // Remove (disable) → the row flags "(Inactive)" and offers Re-enable.
  await peerRow().getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText(`${peerEmail} (Inactive)`)).toBeVisible({
    timeout: 10_000,
  });
  await expect(peerRow().getByRole("button", { name: "Re-enable" })).toBeVisible();

  // Re-enable → back to active (Promote returns, no longer Inactive).
  await peerRow().getByRole("button", { name: "Re-enable" }).click();
  await expect(peerRow().getByRole("button", { name: "Promote" })).toBeVisible({
    timeout: 10_000,
  });
});

test("the last-admin invariant blocks demoting the sole admin in the UI", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");
  const slug = resources.slug("tenancy-lastadmin");
  const org = await seedOrg({ ownerEmail: DEV_EMAIL, slug, name: "Last Admin Org" });

  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/org?tab=users"), {
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({
    timeout: 15_000,
  });

  // Dev is the only (active) admin → its own row's Demote is disabled, with the
  // last-admin tooltip. This is how the invariant surfaces in the UI.
  const selfRow = page.locator(`[data-testid="member-row"][data-email="${DEV_EMAIL}"]`);
  await expect(selfRow).toBeVisible({ timeout: 15_000 });
  const demote = selfRow.getByRole("button", { name: "Demote" });
  await expect(demote).toBeDisabled();
  await expect(demote).toHaveAttribute(
    "title",
    /At least one administrator must remain/i,
  );
});
