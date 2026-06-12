import {
  test,
  expect,
  ensureUser,
  tenantPath,
  DEV_EMAIL,
  seedEmissionKey,
  type TestResources,
} from "./helpers/index.js";
import { seedOrgTenant, type SeededOrgTenant } from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/emit-ac.js";

// Journey 28 (spec-234) — Settings → Emission Keys differentiates the two key types.
//
// A permanent (CI) key and an ephemeral (agent) key are seeded into a tenant the dev user
// is a member of, then the member-visible keys page (/<ns>/<mx>/keys) is asserted to render
// them distinctly: the CI key marked "CI", the agent key marked "Agent" with its scoped
// Spec and expiry. Ephemeral keys have no UI mint path (they come from the
// provision_ac_emission MCP tool), so both are seeded through the test-only surface.
// Verifies ac-8 (differentiation) and ac-20 (expiry shown).

const AC_8 = "mindset-prod/memex-building-itself/specs/spec-234/acs/ac-8";
const AC_20 = "mindset-prod/memex-building-itself/specs/spec-234/acs/ac-20";

interface KeySeed {
  tenant: SeededOrgTenant;
  devId: string;
}

const test2 = test.extend<{ seed: KeySeed }>({
  seed: async ({ resources }: { resources: TestResources }, use) => {
    const devId = await ensureUser(DEV_EMAIL);
    const tenant = await seedOrgTenant({ slug: resources.slug("j28") });
    // Both attributed to dev so they show in dev's (role-scoped) key list.
    await seedEmissionKey({
      memexId: tenant.memexId,
      createdByUserId: devId,
      kind: "permanent",
      name: "pythonia CI",
    });
    await seedEmissionKey({
      memexId: tenant.memexId,
      createdByUserId: devId,
      kind: "ephemeral",
      specHandle: "spec-234",
    });
    await use({ tenant, devId });
  },
});

test2.describe("spec-234 — emission key type differentiation", () => {
  test2.afterEach(async ({}, testInfo) => {
    if (testInfo.status === "skipped") return;
    await emitAcEvents(
      [AC_8, AC_20],
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/journey-28-spec-234-emission-key-types.spec.ts::${testInfo.title}`,
      testInfo.duration,
    );
  });

  test2("the keys page marks a CI key and an Agent key distinctly, with expiry", async ({
    page,
    seed,
  }) => {
    await page.goto(tenantPath(seed.tenant.namespaceSlug, seed.tenant.memexSlug, "/keys"));

    const typeCells = page.getByTestId("emission-key-type");
    await expect(typeCells.first()).toBeVisible({ timeout: 15_000 });

    const permanent = page.locator(
      '[data-testid="emission-key-type"][data-kind="permanent"]',
    );
    const ephemeral = page.locator(
      '[data-testid="emission-key-type"][data-kind="ephemeral"]',
    );

    await expect(permanent).toHaveCount(1);
    await expect(ephemeral).toHaveCount(1);

    // CI key is labelled CI; agent key is labelled Agent and shows its Spec + expiry.
    await expect(permanent).toContainText("CI");
    await expect(ephemeral).toContainText("Agent");
    await expect(ephemeral).toContainText("spec-234");
    await expect(ephemeral).toContainText(/expires/);
  });
});
