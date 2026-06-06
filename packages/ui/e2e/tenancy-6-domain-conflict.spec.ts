// spec-172 ac-5 (tenancy flow 6 of 6) — domain-verification conflict, written
// fresh against the current UI per dec-1.
//
// Two orgs claim the same email domain. Org A verifies it first (seeded over the
// test surface — the winning side). Dev, admin of org B, then clicks "Verify via
// email" in the real SettingsTab; the server rejects with 409 and the admin
// client surfaces the conflict message inline. All path-based [per std-2];
// Postmark is never contacted (the loser never gets as far as sending an email —
// the server 409s at verify-initiate time).

import {
  test,
  expect,
  tenantPath,
  DEV_EMAIL,
  ensureUser,
  setUserName,
  seedOrg,
  addOrgDomain,
  verifyDomain,
  emitAcEvents,
} from "./helpers/index.js";

const AC5 = ["mindset-prod/memex-building-itself/specs/spec-172/acs/ac-5"];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    AC5,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/tenancy-6-domain-conflict.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("a second org cannot verify a domain already verified by another org (409 inline)", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");
  const domain = `${resources.slug("tenancy-conflict")}.test`;

  // Org A (peer-owned) claims AND verifies the domain first — the winning side.
  const peerEmail = resources.email("rival");
  await ensureUser(peerEmail);
  const slugA = resources.slug("tenancy-cfa");
  const orgA = await seedOrg({ ownerEmail: peerEmail, slug: slugA, name: "Conflict Org A" });
  await addOrgDomain({ orgId: orgA.orgId, domain });
  await verifyDomain({ orgId: orgA.orgId, domain });

  // Org B (dev admin) claims the SAME domain — the losing side.
  const slugB = resources.slug("tenancy-cfb");
  const orgB = await seedOrg({ ownerEmail: DEV_EMAIL, slug: slugB, name: "Conflict Org B" });
  await addOrgDomain({ orgId: orgB.orgId, domain });

  // In org B's Settings, the domain is claimed-but-unverified, so "Verify via
  // email" shows. Clicking it must surface the cross-org 409 inline.
  await page.goto(tenantPath(orgB.namespaceSlug, orgB.memexSlug, "/org?tab=settings"), {
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { name: "Email domains" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("code", { hasText: domain })).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole("button", { name: "Verify via email" }).click();

  // The server's 409 message ("…already verified by another org") is rendered in
  // the inline error banner.
  await expect(page.getByText(/already verified by another org/i)).toBeVisible({
    timeout: 10_000,
  });
});
