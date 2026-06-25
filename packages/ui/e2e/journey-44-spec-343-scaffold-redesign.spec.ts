// Journey 44 — the redesigned Scaffold Inspect/Extend surface (spec-343).
//
// One end-to-end story of an ADMIN using the redesigned scaffold: open the
// lifecycle timeline → select a phase → drill into a tool's circumstance → read
// the exact composed prompt (base prose, inline) → add the team's own guidance
// in context (target derived from position, no dimension builder) → watch it
// compose inline as a "your team" segment. Navigation is path-based [std-2];
// all seeding goes over the test-only HTTP surface (real services → std-8 bus);
// no SQL. seedOrgTenant makes dev@memex.ai an active administrator, so the
// edit affordances render and the POST /scaffold/additions write succeeds.
//
// Verifies spec-343 ac-2 (composed prompt shown base-vs-yours inline) and
// ac-3 (in-context add with derived target composes live).

import { test, expect, tenantPath, type TestResources } from "./helpers/index.js";
import { seedOrgTenant, type SeededOrgTenant } from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/index.js";
import type { Page } from "@playwright/test";

const AC = [
  "mindset-prod/memex-building-itself/specs/spec-343/acs/ac-2",
  "mindset-prod/memex-building-itself/specs/spec-343/acs/ac-3",
];

interface ScaffoldSeed {
  tenant: SeededOrgTenant;
}

const test2 = test.extend<{ seed: ScaffoldSeed }>({
  seed: async ({ resources }: { resources: TestResources }, use) => {
    const slug = resources.slug("j44");
    const tenant = await seedOrgTenant({ slug });
    await use({ tenant });
  },
});

async function gotoScaffold(page: Page, seed: ScaffoldSeed) {
  await page.goto(tenantPath(seed.tenant.namespaceSlug, seed.tenant.memexSlug, "/scaffold"));
  await expect(page.getByTestId("scaffold-timeline")).toBeVisible({ timeout: 15_000 });
}

test2.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-44-spec-343-scaffold-redesign.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test2.describe("Scaffold redesign — inspect a circumstance and add guidance (spec-343)", () => {
  test2("admin drills into a tool circumstance, reads the composed prompt, and adds inline guidance", async ({
    page,
    seed,
  }) => {
    await gotoScaffold(page, seed);

    // The landing IS the timeline map (ac-13) — phases on the spine, gates between.
    await expect(page.getByTestId("scaffold-timeline-phase-build")).toBeVisible();
    await expect(page.getByTestId("scaffold-timeline-gate-build")).toBeVisible();

    // Select the build phase → its detail splits into reach groups (ac-12).
    await page.getByTestId("scaffold-timeline-phase-build").click();
    await expect(page.getByTestId("scaffold-phase-detail-build")).toBeVisible();
    await expect(page.getByTestId("scaffold-reach-group-both")).toBeVisible();

    // Drill into create_task → its composed nudge renders as inline segments
    // (ac-2: base prose shown distinctly, in composition order).
    await page.getByTestId("scaffold-tool-create_task").click();
    const detail = page.getByTestId("scaffold-circumstance-nudge");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("scaffold-segment").first()).toBeVisible();

    // Add the team's own guidance in context — target derived from position,
    // stated in plain language, no raw dimension dropdowns (ac-3).
    await detail.getByTestId("scaffold-add-here-trigger").click();
    await expect(page.getByTestId("scaffold-add-here-target-summary")).toContainText(
      "when create_task runs during build",
    );
    const unique = `E2E TEAM GUIDANCE ${Date.now()}`;
    await page.getByTestId("scaffold-add-here-text").fill(unique);
    await page.getByTestId("scaffold-add-here-rationale").fill("authored by the journey");
    await page.getByTestId("scaffold-add-here-submit").click();

    // It composes inline as a "your team" segment (ac-3) — the editor IS the
    // preview; there is no separate Live preview pane (dec-4).
    const composed = page.getByTestId("scaffold-circumstance-nudge");
    await expect(composed).toContainText(unique, { timeout: 15_000 });
    await expect(
      composed.getByTestId("scaffold-segment").filter({ hasText: unique }),
    ).toHaveAttribute("data-source", "org");
  });
});
