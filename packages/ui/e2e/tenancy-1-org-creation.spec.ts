// spec-172 ac-5 (tenancy flow 1 of 6) — org creation, written fresh against the
// current UI per dec-1. From the personal context the dev user opens the Create
// Org dialog (CreateOrgForm), the slug-availability check clears, and on submit
// the app lands on the new Org's namespace home (/<ns>/ — NamespaceHome's "Your
// Orgs" view). All navigation is path-based [per std-2]; the only seeding is
// marking the dev user's email verified (the real CreateOrgForm gates on it),
// done over the test-only HTTP surface — never SQL, never Postmark.

import {
  test,
  expect,
  bareUrl,
  tenantPath,
  DEV_EMAIL,
  getPersonalMemexByEmail,
  setUserName,
  markEmailVerified,
  emitAcEvents,
} from "./helpers/index.js";

const AC5 = ["mindset-prod/memex-building-itself/specs/spec-172/acs/ac-5"];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    AC5,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/tenancy-1-org-creation.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("personal user creates an Org and lands on its namespace home", async ({
  page,
  resources,
}) => {
  // The org-creation dialog renders the form only when the session reports the
  // email verified, and POST /api/orgs rejects unverified users — so mark the
  // dev user verified before loading the page (its session is fetched fresh).
  await markEmailVerified(DEV_EMAIL);

  // Bootstrap the dev session and land on the personal Specs board.
  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  if (!memex) throw new Error("dev@memex.ai personal memex missing — globalSetup should have provisioned it");
  await setUserName(DEV_EMAIL, "Dev User");

  // The personal NamespaceHome carries the "Create an Org →" CTA.
  await page.goto(bareUrl(`/${memex.namespaceSlug}`), { waitUntil: "commit" });
  const createCta = page.getByRole("button", { name: /Create an Org/i });
  await expect(createCta).toBeVisible({ timeout: 15_000 });
  await createCta.click();

  // CreateOrgDialog → CreateOrgForm. Type a unique, available slug; the 400ms
  // debounced availability check must resolve to "✓ Available".
  const slug = resources.slug("tenancy-org");
  await expect(page.getByRole("heading", { name: "Create a new Org" })).toBeVisible();
  const slugInput = page.getByPlaceholder("acme");
  await expect(slugInput).toBeVisible();
  await slugInput.fill(slug);
  await expect(page.getByLabel("slug available")).toBeVisible({ timeout: 10_000 });

  // Submit — the form posts to /api/orgs and full-navigates to /<slug>/.
  await page.getByRole("button", { name: "Create Org" }).click();

  // Landed on the new Org's namespace home — NamespaceHome's org variant.
  await page.waitForURL((url) => url.pathname.replace(/\/$/, "") === `/${slug}`, {
    timeout: 15_000,
  });
  await expect(page.getByRole("heading", { name: "Your Orgs" })).toBeVisible({
    timeout: 15_000,
  });

  // The org card the user just created is present (admin can add a Memex).
  await expect(page.getByRole("button", { name: "+ Add Memex" }).first()).toBeVisible({
    timeout: 15_000,
  });

  // Sanity: tenantPath builds a path-based URL under the new namespace (std-2).
  expect(tenantPath(slug, "main", "/specs")).toContain(`/${slug}/main/specs`);
});
