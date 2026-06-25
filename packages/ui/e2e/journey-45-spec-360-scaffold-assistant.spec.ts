// Journey 45 — the scaffold assistant on the Scaffold Inspect surface (spec-360).
//
// One end-to-end story: a member opens the redesigned scaffold and finds the
// scaffold ASSISTANT docked in the left rail alongside the lifecycle timeline —
// available to explain what each agent reads and where it applies. The panel and
// its chat input render live (the surface enters `scaffold` agent mode on
// mount), so explanation is open to any active member. Navigation is path-based
// [std-2]; all seeding goes over the test-only HTTP surface (real services →
// std-8 bus); no SQL.
//
// The propose-then-confirm AUTHORING flow (ask → propose_scaffold_change →
// composed preview → approve) drives a non-deterministic LLM turn, so it is
// verified deterministically at the unit/integration layer (the server tool's
// admin gate + no-write + validate-and-pushback; the ScaffoldProposalReview
// composed preview + approve/reject; the ChatContext proposal parsing). This
// journey covers the user-facing SURFACE the spec adds: the assistant is present
// and usable for explanation on the scaffold page.
//
// Verifies spec-360 ac-1 (the assistant explains the scaffold; available to any
// viewer on the surface).

import { test, expect, tenantPath, type TestResources } from "./helpers/index.js";
import { seedOrgTenant, type SeededOrgTenant } from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/index.js";
import type { Page } from "@playwright/test";

const AC = ["mindset-prod/memex-building-itself/specs/spec-360/acs/ac-1"];

interface ScaffoldSeed {
  tenant: SeededOrgTenant;
}

const test2 = test.extend<{ seed: ScaffoldSeed }>({
  seed: async ({ resources }: { resources: TestResources }, use) => {
    const slug = resources.slug("j45");
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
    `packages/ui/e2e/journey-45-spec-360-scaffold-assistant.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test2.describe("Scaffold assistant — available on the scaffold surface (spec-360)", () => {
  test2("the assistant panel renders in the left rail alongside the timeline", async ({
    page,
    seed,
  }) => {
    await gotoScaffold(page, seed);

    // The assistant rides the surface as a left-rail panel (the established
    // Standards/Drift agent position).
    const panel = page.getByTestId("scaffold-assistant-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Scaffold assistant")).toBeVisible();

    // The chat host is mounted and the conversation is LIVE on arrival (scaffold
    // mode binds no doc), so a viewer can immediately ask what the agents read.
    await expect(page.getByTestId("chat-input")).toBeEnabled();

    // The timeline (explain target the assistant points at) is present beside it.
    await expect(page.getByTestId("scaffold-timeline")).toBeVisible();
  });
});
