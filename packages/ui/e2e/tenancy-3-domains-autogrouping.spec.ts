// spec-172 ac-5 (tenancy flow 3 of 6) — domain add + verification + auto-grouping
// gating, written fresh against the current UI per dec-1.
//
// Two journeys, both path-based [per std-2] and both Postmark-free:
//   (a) Happy path: admin adds a (non-free) domain in the SettingsTab, the
//       verification token is fetched over the test-only surface (the postmaster@
//       email stand-in — Postmark is NEVER hit), the admin walks the real
//       VerifyDomain two-step confirm, the domain flips to "verified (email)",
//       and auto-grouping can then be toggled on (AutoGroupingSection).
//   (b) Gating: a free-mail domain (gmail.com) surfaces a "free provider" badge
//       and blocks the auto-grouping toggle (the checkbox is disabled) — dec-7.

import {
  test,
  expect,
  tenantPath,
  bareUrl,
  DEV_EMAIL,
  setUserName,
  seedOrg,
  createDomainVerification,
  emitAcEvents,
} from "./helpers/index.js";

const AC5 = ["mindset-prod/memex-building-itself/specs/spec-172/acs/ac-5"];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    AC5,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/tenancy-3-domains-autogrouping.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("admin adds a domain, verifies it via the link, then enables auto-grouping", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");
  const slug = resources.slug("tenancy-dom");
  const org = await seedOrg({ ownerEmail: DEV_EMAIL, slug, name: "Domains Org" });
  // A unique, non-free domain (the `.test` TLD is never on the free list).
  const domain = `${slug}.test`;

  // Settings tab, scoped to the org tenant so /orgs/current/* resolves this org.
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/org?tab=settings"), {
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { name: "Email domains" })).toBeVisible({
    timeout: 15_000,
  });

  // Add the domain through the real UI.
  await page.getByPlaceholder("acme.com").fill(domain);
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(page.locator("code", { hasText: domain })).toBeVisible({
    timeout: 10_000,
  });

  // It's claimed but not yet verified — the "Verify via email" affordance shows.
  await expect(page.getByRole("button", { name: "Verify via email" })).toBeVisible();

  // Fetch the verification token over the test surface — the postmaster@ email
  // stand-in. Then walk the real VerifyDomain two-step confirm.
  const { token } = await createDomainVerification({ orgId: org.orgId, domain });
  await page.goto(bareUrl(`/verify-domain/${token}`), { waitUntil: "commit" });
  await expect(
    page.getByRole("heading", { name: "Confirm domain verification" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("heading", { name: "Verified" })).toBeVisible({
    timeout: 15_000,
  });

  // Back in Settings the domain now reads "verified (email)" and auto-grouping
  // can be toggled on (no longer blocked).
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/org?tab=settings"), {
    waitUntil: "commit",
  });
  await expect(page.getByText(/verified \(email\)/i)).toBeVisible({ timeout: 15_000 });

  const toggle = page.getByRole("checkbox");
  await expect(toggle).toBeEnabled();
  await toggle.check();
  // The label flips once the PATCH resolves and the summary refreshes.
  await expect(page.getByText("Auto-grouping enabled")).toBeVisible({ timeout: 10_000 });
});

test("a free-mail domain blocks the auto-grouping toggle (dec-7 gating)", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");
  const slug = resources.slug("tenancy-free");
  const org = await seedOrg({ ownerEmail: DEV_EMAIL, slug, name: "Free Domain Org" });

  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/org?tab=settings"), {
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { name: "Email domains" })).toBeVisible({
    timeout: 15_000,
  });

  // Add a free provider — gmail.com is on the server's free-domains list.
  await page.getByPlaceholder("acme.com").fill("gmail.com");
  await page.getByRole("button", { name: "Add domain" }).click();

  // The free badge appears and there is NO "Verify via email" affordance for it.
  await expect(page.getByText("free provider")).toBeVisible({ timeout: 10_000 });

  // AutoGroupingSection is gated: the checkbox is disabled and the dec-7 reason
  // is surfaced inline.
  await expect(page.getByRole("checkbox")).toBeDisabled();
  await expect(
    page.getByText(/Disabled because this Org claims free email providers/i),
  ).toBeVisible();
});
