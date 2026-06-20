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

// Journey 28 (spec-234) — the keys page differentiates the two key types.
//
// A permanent (CI) key and an ephemeral (agent) key are seeded into a tenant the dev user
// is a member of, then the member-visible keys page (/<ns>/<mx>/keys) is asserted to render
// them distinctly. Per spec-309 (dec-5) the differentiation moved from a per-row "Type"
// cell to the CI/Agent type toggle + type-aware columns: the CI key lives in the (default)
// CI view, the agent key in the Agent view where its scoped Spec and expiry are their own
// columns. Ephemeral keys have no UI mint path (they come from the provision_ac_emission
// MCP tool), so both are seeded through the test-only surface.
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

  test2("CI and Agent keys render in distinct views, the agent key showing its Spec + expiry", async ({
    page,
    seed,
  }) => {
    await page.goto(tenantPath(seed.tenant.namespaceSlug, seed.tenant.memexSlug, "/keys"));

    // The two types are surfaced as separately-counted toggle segments (CI 1 / Agent 1).
    const ciSeg = page.getByRole("radio", { name: /CI/ });
    const agentSeg = page.getByRole("radio", { name: /Agent/ });
    await expect(ciSeg).toBeVisible({ timeout: 15_000 });
    await expect(ciSeg).toHaveText(/1/);
    await expect(agentSeg).toHaveText(/1/);

    // Default CI view shows the CI key, not the agent key (ac-8 — distinguishable).
    await expect(page.getByText("pythonia CI")).toBeVisible();
    await expect(ciSeg).toHaveAttribute("aria-checked", "true");

    // Switch to the Agent view: the agent key's scoped Spec and expiry are surfaced
    // under their own columns (ac-20), no longer crammed into a Type cell.
    await agentSeg.click();
    await expect(page.getByTestId("emission-keys-table")).toHaveAttribute(
      "data-view",
      "ephemeral",
    );
    await expect(page.getByTestId("emission-key-spec")).toContainText("spec-234");
    await expect(page.getByTestId("emission-key-expires")).toContainText(/in \d|expired/);
  });
});
