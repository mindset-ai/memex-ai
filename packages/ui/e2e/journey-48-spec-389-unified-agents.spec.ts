// Journey 48 — the unified in-app agents on the Standards + Issues surfaces (spec-389).
//
// One end-to-end story: a member opens the Standards surface and finds the
// STANDARDS agent docked in the left rail on the one shared agent standard (the
// shell set by the scaffold assistant, spec-360); the same is true of the ISSUES
// agent on the Issues surface. Each agent opens with the shared STATIC intro card
// — NOT a money-burning opening LLM turn (dec-1) — a simple "<X> agent" heading,
// a live chat input, and the shared collapse-to-strip affordance. Navigation is
// path-based [std-2]; all seeding goes over the test-only HTTP surface (real
// services → std-8 bus); no SQL.
//
// The propose-then-confirm AUTHORING flows (clause edits, issue triage) drive
// non-deterministic LLM turns, so they are verified deterministically at the
// unit/integration layer (the MODE_TOOLS gate, the context builders, the system
// prompt blocks, ChatContext mode entry). This journey covers the user-facing
// SURFACE spec-389 adds: each agent is present, on the unified shell, and usable.
//
// Verifies spec-389 ac-1 (the one visual standard) and ac-4 (the standards +
// issues agents live on their surfaces).

import { test, expect, tenantPath, type TestResources } from "./helpers/index.js";
import { seedOrgTenant, type SeededOrgTenant } from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/index.js";
import type { Page } from "@playwright/test";

const AC = [
  "mindset-prod/memex-building-itself/specs/spec-389/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-389/acs/ac-4",
];

interface AgentSeed {
  tenant: SeededOrgTenant;
}

const test2 = test.extend<{ seed: AgentSeed }>({
  seed: async ({ resources }: { resources: TestResources }, use) => {
    const slug = resources.slug("j48");
    const tenant = await seedOrgTenant({ slug });
    await use({ tenant });
  },
});

async function goto(page: Page, seed: AgentSeed, path: string) {
  await page.goto(tenantPath(seed.tenant.namespaceSlug, seed.tenant.memexSlug, path));
}

test2.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-48-spec-389-unified-agents.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test2.describe("Unified in-app agents on Standards + Issues (spec-389)", () => {
  test2("the standards agent docks on the Standards surface with the unified shell", async ({
    page,
    seed,
  }) => {
    await goto(page, seed, "/standards");

    // The agent rides the surface as a left-rail panel (the shared rail position).
    const panel = page.getByTestId("standards-assistant-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText("Standards agent")).toBeVisible();

    // It opens with the shared STATIC intro card — and, per dec-1, NO opening LLM
    // turn: an assistant message would render a chat-markdown block, and there are
    // none on arrival. The intro persists because the thread is empty.
    await expect(page.getByTestId("agent-intro-standards")).toBeVisible();
    await expect(page.getByTestId("chat-markdown")).toHaveCount(0);

    // The conversation is LIVE on arrival (standards mode binds no doc), so a
    // member can immediately ask about the Standards.
    await expect(page.getByTestId("chat-input")).toBeEnabled();

    // The Standards content (the explain target) renders beside it.
    await expect(page.getByTestId("standards-view-toggle")).toBeVisible();
  });

  test2("the issues agent docks on the Issues surface with the unified shell", async ({
    page,
    seed,
  }) => {
    await goto(page, seed, "/issues");

    const panel = page.getByTestId("issues-assistant-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText("Issues agent")).toBeVisible();

    // Same shared shell: static intro card, no opening LLM turn, live input.
    await expect(page.getByTestId("agent-intro-issues")).toBeVisible();
    await expect(page.getByTestId("chat-markdown")).toHaveCount(0);
    await expect(page.getByTestId("chat-input")).toBeEnabled();

    // The Issues content renders beside it (the page H1, not the "Issues agent"
    // panel heading — hence exact).
    await expect(page.getByRole("heading", { name: "Issues", exact: true })).toBeVisible();
  });

  test2("the agent panel collapses to a strip and reopens (shared visual standard)", async ({
    page,
    seed,
  }) => {
    await goto(page, seed, "/standards");

    const panel = page.getByTestId("standards-assistant-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // Collapse: the header control closes the panel to its thin strip; the chat
    // input goes away and the strip takes its place (the kanban Done-column shape).
    await page.getByTestId("chat-collapse").click();
    const strip = page.getByTestId("standards-assistant-panel-collapsed");
    await expect(strip).toBeVisible();
    await expect(page.getByTestId("chat-input")).toHaveCount(0);

    // Reopen: clicking the strip restores the full panel and its live input.
    await strip.click();
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("chat-input")).toBeEnabled();
  });
});
