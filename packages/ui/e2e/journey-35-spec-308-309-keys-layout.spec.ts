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

// Journey 35 (spec-308 + spec-309) — the Memex keys page layout & type filter.
//
// spec-308 widened the page to max-w-5xl so the emission-keys table stops wrapping.
// spec-309 added a CI/Agent type toggle (CI by default, per-type counts) and type-aware
// columns: the Agent view promotes Spec + Expires to their own columns and drops the
// redundant Type column; the CI view stays lean. Both surfaces are exercised here against
// a seeded tenant the dev user owns, via path-based nav and the test-only seed surface.

const REFS: Record<string, string[]> = {
  // spec-309: default-CI + counts + filtering + type-aware columns.
  "filters the keys table by type, with type-aware columns": [
    "mindset-prod/memex-building-itself/specs/spec-309/acs/ac-1",
    "mindset-prod/memex-building-itself/specs/spec-309/acs/ac-2",
    "mindset-prod/memex-building-itself/specs/spec-309/acs/ac-3",
    "mindset-prod/memex-building-itself/specs/spec-309/acs/ac-9",
    "mindset-prod/memex-building-itself/specs/spec-309/acs/ac-12",
    "mindset-prod/memex-building-itself/specs/spec-309/acs/ac-13",
    "mindset-prod/memex-building-itself/specs/spec-309/acs/ac-15",
  ],
  // spec-309: per-type empty state.
  "shows a per-type empty state for a type with no keys": [
    "mindset-prod/memex-building-itself/specs/spec-309/acs/ac-4",
  ],
  // spec-308: the page uses the widened layout.
  "renders the keys page at the widened (max-w-5xl) layout": [
    "mindset-prod/memex-building-itself/specs/spec-308/acs/ac-1",
  ],
};

interface KeysCtx {
  tenant: SeededOrgTenant;
  devId: string;
}

const test2 = test.extend<{ ctx: KeysCtx }>({
  ctx: async ({ resources }: { resources: TestResources }, use) => {
    const devId = await ensureUser(DEV_EMAIL);
    const tenant = await seedOrgTenant({ slug: resources.slug("j35") });
    await use({ tenant, devId });
  },
});

test2.describe("spec-308 + spec-309 — keys page layout & type filter", () => {
  test2.afterEach(async ({}, testInfo) => {
    if (testInfo.status === "skipped") return;
    const refs = REFS[testInfo.title];
    if (!refs) return;
    await emitAcEvents(
      refs,
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/journey-35-spec-308-309-keys-layout.spec.ts::${testInfo.title}`,
      testInfo.duration,
    );
  });

  test2("filters the keys table by type, with type-aware columns", async ({ page, ctx }) => {
    // Two CI keys + one agent key → counts CI 2 / Agent 1.
    await seedEmissionKey({ memexId: ctx.tenant.memexId, createdByUserId: ctx.devId, kind: "permanent", name: "pythonia CI" });
    await seedEmissionKey({ memexId: ctx.tenant.memexId, createdByUserId: ctx.devId, kind: "permanent", name: "github actions" });
    await seedEmissionKey({ memexId: ctx.tenant.memexId, createdByUserId: ctx.devId, kind: "ephemeral", specHandle: "spec-80" });

    await page.goto(tenantPath(ctx.tenant.namespaceSlug, ctx.tenant.memexSlug, "/keys"));

    const ciSeg = page.getByRole("radio", { name: /CI/ });
    const agentSeg = page.getByRole("radio", { name: /Agent/ });

    // The toggle sits above the table, CI selected by default, with per-type counts.
    await expect(ciSeg).toBeVisible({ timeout: 15_000 });
    await expect(ciSeg).toHaveAttribute("aria-checked", "true");
    await expect(ciSeg).toHaveText(/2/);
    await expect(agentSeg).toHaveText(/1/);

    // CI view: the CI keys show; the agent key does not; columns are the lean CI set
    // (no Spec / Expires / Type).
    const table = page.getByTestId("emission-keys-table");
    await expect(table).toHaveAttribute("data-view", "permanent");
    await expect(page.getByText("pythonia CI")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Spec" })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Expires" })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Type" })).toHaveCount(0);

    // Switch to Agent: filtering is instant (no nav), Spec + Expires become real
    // columns, the agent key's Spec shows, and there's still no Type column.
    await agentSeg.click();
    await expect(table).toHaveAttribute("data-view", "ephemeral");
    await expect(page.getByRole("columnheader", { name: "Spec" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Expires" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Type" })).toHaveCount(0);
    await expect(page.getByTestId("emission-key-spec")).toContainText("spec-80");
    await expect(page.getByText("pythonia CI")).toHaveCount(0);
  });

  test2("shows a per-type empty state for a type with no keys", async ({ page, ctx }) => {
    // Only a CI key → the Agent view is empty.
    await seedEmissionKey({ memexId: ctx.tenant.memexId, createdByUserId: ctx.devId, kind: "permanent", name: "pythonia CI" });

    await page.goto(tenantPath(ctx.tenant.namespaceSlug, ctx.tenant.memexSlug, "/keys"));

    const agentSeg = page.getByRole("radio", { name: /Agent/ });
    await expect(agentSeg).toBeVisible({ timeout: 15_000 });
    await expect(agentSeg).toHaveText(/0/);

    await agentSeg.click();
    // A type-specific empty state, not a blank table or the generic "no keys yet".
    const empty = page.getByTestId("emission-keys-empty-ephemeral");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/created automatically/i);
    await expect(page.getByTestId("emission-keys-table")).toHaveCount(0);
  });

  test2("renders the keys page at the widened (max-w-5xl) layout", async ({ page, ctx }) => {
    await seedEmissionKey({ memexId: ctx.tenant.memexId, createdByUserId: ctx.devId, kind: "permanent", name: "pythonia CI" });

    await page.goto(tenantPath(ctx.tenant.namespaceSlug, ctx.tenant.memexSlug, "/keys"));

    // The page content sits in the data-rich max-w-5xl container (spec-308 dec-1),
    // not the old narrow max-w-2xl column.
    await expect(page.getByRole("heading", { name: "Emission Keys" })).toBeVisible({ timeout: 15_000 });
    const widePage = page.locator(".max-w-5xl").filter({ hasText: "Emission Keys" });
    await expect(widePage.first()).toBeVisible();
  });
});
