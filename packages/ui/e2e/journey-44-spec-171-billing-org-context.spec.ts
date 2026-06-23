import {
  test,
  expect,
  bareUrl,
  tenantPath,
  DEV_EMAIL,
  setUserName,
  seedOrg,
  setOrgBilling,
  emitAcEvents,
} from "./helpers/index.js";

// Journey 44 — spec-171 ac-39: billing is per-org, and the org is resolved from
// CONTEXT, never re-asked redundantly (std-28 gate).
//
// Two surfaces, both manual-testing-in-verify defects:
//
//   1. The Billing tab inside an ORG's tenant page (/<ns>/<mx>/org?tab=billing)
//      bills THAT org directly — it does NOT show the "which organisation are you
//      upgrading?" chooser (the org is unambiguous: it's in the URL, and the page
//      is already gated on admin-of-it). When the caller admins several orgs a
//      "Managing organisation" SELECT lets them jump to another org's billing
//      (navigating to that org's page), instead of an in-place "switch" link.
//
//   2. The /upgrade flow is org-FIRST: the org is chosen on the plan-select step
//      (the plan CTAs stay disabled until one is picked) and carried into
//      /upgrade/:plan as ?org=<id>, where it's shown READ-ONLY — no chooser after
//      a plan is picked.
//
// Both emit ac-39 (the hosted upgrade/billing flow resolves the chosen org's
// tenant, never the session's default/personal memex).

const AC = ["mindset-prod/memex-building-itself/specs/spec-171/acs/ac-39"];

const CHOOSER_LEGEND = "Which organisation are you upgrading?";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-44-spec-171-billing-org-context.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("billing tab in an org's tenant page bills THAT org — no chooser, a switcher select to other orgs (ac-39)", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");

  // Two orgs the dev user administers — so the chooser COULD appear if the tenant
  // context were ignored (the bug), and so the multi-org switcher select renders.
  const slug1 = resources.slug("billctx-one");
  const slug2 = resources.slug("billctx-two");
  const org1 = await seedOrg({ ownerEmail: DEV_EMAIL, slug: slug1, name: "Org Context One" });
  const org2 = await seedOrg({ ownerEmail: DEV_EMAIL, slug: slug2, name: "Org Context Two" });
  // Put org1 on a real paid tier so the billing page is a representative,
  // populated Premium/Enterprise view (unique customer id per seed).
  await setOrgBilling({
    orgId: org1.orgId,
    stripeCustomerId: `cus_test_${slug1}`,
    planTier: "enterprise",
    seatsPurchased: 5,
  });

  // ── navigate to ORG1's billing tab (tenant-scoped) ──────────────────────────
  await page.goto(tenantPath(org1.namespaceSlug, org1.memexSlug, "/org?tab=billing"), {
    waitUntil: "commit",
  });

  // The plan view renders directly — proof the org was resolved from the URL
  // (not stuck on a chooser). Non-vacuous wait before the absence assertion.
  await expect(
    page.getByRole("heading", { name: "Current plan" }),
  ).toBeVisible({ timeout: 15_000 });

  // ISSUE #1 — the org chooser must NOT appear in tenant context.
  await expect(page.getByText(CHOOSER_LEGEND)).toHaveCount(0);

  // ISSUE #2 — a "Managing organisation" SELECT (not a switch link), defaulted to
  // the org in the URL, listing every org the caller administers.
  const orgSelect = page.getByLabel("Managing organisation");
  await expect(orgSelect).toBeVisible();
  await expect(orgSelect).toHaveValue(org1.orgId);
  await expect(page.getByRole("option", { name: "Org Context One" })).toBeAttached();
  await expect(page.getByRole("option", { name: "Org Context Two" })).toBeAttached();

  // Switching the select navigates to the OTHER org's billing page (the URL and
  // the shown org stay in sync — an in-place swap would desync them).
  await orgSelect.selectOption(org2.orgId);
  await expect(page).toHaveURL(
    new RegExp(`/${org2.namespaceSlug}/${org2.memexSlug}/org\\?tab=billing`),
  );
});

test("org-first upgrade — pick the org on plan-select, seats screen shows it read-only, no chooser (ac-39)", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");

  const slug1 = resources.slug("upfirst-one");
  const slug2 = resources.slug("upfirst-two");
  const org1 = await seedOrg({ ownerEmail: DEV_EMAIL, slug: slug1, name: "Upgrade First One" });
  await seedOrg({ ownerEmail: DEV_EMAIL, slug: slug2, name: "Upgrade First Two" });

  // ── plan select (flat /upgrade) ─────────────────────────────────────────────
  await page.goto(bareUrl("/upgrade"), { waitUntil: "commit" });
  await expect(
    page.getByRole("heading", { name: "Choose your plan" }),
  ).toBeVisible({ timeout: 15_000 });

  // With several admin orgs the chooser appears HERE (step 1), and the plan CTAs
  // are disabled until an org is picked — so the org is settled before any plan.
  await expect(page.getByText(CHOOSER_LEGEND)).toBeVisible({ timeout: 15_000 });
  const premiumCta = page.getByRole("button", { name: "Upgrade to Premium" });
  await expect(premiumCta).toBeDisabled();

  // Pick org1 → the chooser collapses to the confirmation card and the plan CTAs
  // enable. Use click (not check): selecting auto-flips to the card, detaching the
  // radio before check()'s post-select verification can read it.
  await page.getByRole("radio", { name: "Upgrade First One" }).click();
  await expect(page.getByText("Upgrading organisation")).toBeVisible();
  await expect(page.getByText("Upgrade First One")).toBeVisible();
  await expect(premiumCta).toBeEnabled();

  // ── → seats screen, org carried in as ?org=<id> ─────────────────────────────
  await premiumCta.click();
  await expect(page).toHaveURL(new RegExp(`/upgrade/premium\\?org=${org1.orgId}`));

  // The chosen org is shown READ-ONLY here — and the chooser does NOT reappear.
  await expect(page.getByText("Upgrading organisation")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Upgrade First One")).toBeVisible();
  await expect(page.getByText(CHOOSER_LEGEND)).toHaveCount(0);
});
