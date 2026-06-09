// spec-193 t-5 / t-8 — per-memex scaffold scope, the user-facing flow.
//
// std-28 (PR-gate e2e): spec-193 adds a Scope control to the Scaffold Inspect
// authoring editor so an admin can scope an org guidance addition to a single
// memex (the override) instead of account-wide (the default). That is a new
// user-facing flow, so it earns a Playwright journey here.
//
// The journey, all path-based [per std-2], seeded over the test-only HTTP
// surface (never raw SQL):
//   1. Seed an org owned by the dev user (→ dev is an administrator), with a memex.
//   2. Open /<ns>/<mx>/scaffold, pick the build phase, open the inline editor.
//   3. Assert the Scope control is present and offers "This memex only".
//   4. Author a block scoped to THIS memex and submit.
//   5. Assert the new block lands in the Inspect list (authored, no deploy).
//
// Tags ac-7 (vocabulary is data a team extends in the React UI, scoped per-memex)
// and ac-20 (extension flows through org_scaffold_additions, no new docType).

import {
  test,
  expect,
  tenantPath,
  DEV_EMAIL,
  setUserName,
  seedOrg,
  emitAcEvents,
} from "./helpers/index.js";

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-193/acs/ac-7",
  "mindset-prod/memex-building-itself/specs/spec-193/acs/ac-20",
];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-25-tripwire-scope.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("admin scopes a scaffold guidance addition to this memex only", async ({
  page,
  resources,
}) => {
  await setUserName(DEV_EMAIL, "Dev User");
  const slug = resources.slug("tripwire-scope");
  const org = await seedOrg({
    ownerEmail: DEV_EMAIL,
    slug,
    name: "Tripwire Scope Org",
  });

  // Open the Scaffold Inspect page for the seeded memex.
  await page.goto(tenantPath(org.namespaceSlug, org.memexSlug, "/scaffold"), {
    waitUntil: "commit",
  });
  await expect(page.getByTestId("scaffold-inspect-page")).toBeVisible({
    timeout: 15_000,
  });

  // Select the build phase, then open the inline authoring editor.
  await page.getByTestId("scaffold-rail-phase-build").click();
  await page.getByTestId("scaffold-add-guidance-trigger").click();
  await expect(page.getByTestId("scaffold-add-guidance-form")).toBeVisible();

  // spec-193 t-5: the Scope control exists and offers the per-memex override.
  const scope = page.getByTestId("scaffold-add-scope");
  await expect(scope).toBeVisible();
  await expect(scope.locator("option", { hasText: "This memex only" })).toHaveCount(
    1,
  );

  // Author a block scoped to THIS memex.
  const markerText = `Tripwire scoped guidance ${slug}`;
  await page.getByTestId("scaffold-add-text").fill(markerText);
  await page
    .getByTestId("scaffold-add-rationale")
    .fill("spec-193 journey: per-memex scoped addition");
  await scope.selectOption("memex");
  await page.getByTestId("scaffold-add-submit").click();

  // The form closes on success and the authored block lands in the Inspect list
  // — proving the tenant extended the vocabulary in the UI with no deploy.
  await expect(page.getByTestId("scaffold-add-guidance-form")).toBeHidden({
    timeout: 15_000,
  });
  // exact:true so the locator resolves to the block's own text node, not the
  // many nav ancestors whose textContent also contains the marker (the seeded
  // namespace slug is part of it).
  await expect(page.getByText(markerText, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});
