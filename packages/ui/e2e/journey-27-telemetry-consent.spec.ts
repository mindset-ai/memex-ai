// spec-244 t-8 (std-28) — the front-end telemetry CONSENT flow.
//
// The user-facing surface this Spec adds is the "Product-usage analytics" opt-out
// control in the account Settings tab (the capture itself is invisible by design).
// This journey drives that control through the real UI: it defaults to sharing-on,
// toggles off, and the choice PERSISTS across a reload (the per-user opt-out, which
// gates whether track() fires at all). Path-based nav [per std-2]; no raw SQL.

import {
  test,
  expect,
  tenantPath,
  DEV_EMAIL,
  setUserName,
  seedOrg,
  emitAcEvents,
} from "./helpers/index.js";

const AC = ["mindset-prod/memex-building-itself/specs/spec-244/acs/ac-11"];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-27-telemetry-consent.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("a user can opt out of product-usage analytics, and the choice persists", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");
  const slug = resources.slug("telemetry-consent");
  const org = await seedOrg({ ownerEmail: DEV_EMAIL, slug, name: "Telemetry Org" });

  // Account Settings tab, scoped to the org tenant.
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/org?tab=settings"), {
    waitUntil: "commit",
  });

  // The consent control renders, defaulting to sharing-ON.
  await expect(
    page.getByRole("heading", { name: "Product-usage analytics" }),
  ).toBeVisible({ timeout: 15_000 });
  const toggle = page.getByTestId("telemetry-toggle");
  await expect(toggle).toBeChecked();

  // Opt out.
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("Usage analytics off")).toBeVisible();

  // The opt-out persists across a reload (it gates capture for this browser).
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByTestId("telemetry-toggle")).not.toBeChecked({ timeout: 15_000 });

  // And it can be turned back on.
  await page.getByTestId("telemetry-toggle").check();
  await expect(page.getByTestId("telemetry-toggle")).toBeChecked();
});
