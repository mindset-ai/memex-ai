// Journey 67 — a Spec page hosted in the DESKTOP shell hides the web agent
// (spec-516 dec-10).
//
// The desktop client gives a Spec its own tab split into two columns: a column
// reserved for a later coding session (spec-322) on the left, the Spec on the
// right. But DocumentShell already splits a Spec into two columns of its OWN — the
// agent rail at 24%, then the canvas — so composed inside that tab a Spec rendered
// THREE columns: reserved placeholder, agent rail, canvas. Two narrow left rails
// competing, one of them deliberately empty for months, which is worse than the
// full-width page the desktop layout set out to improve on.
//
// dec-10 settles it in React rather than in the shell: the page already knows when
// it is hosted in the desktop (isDesktopShell(), spec-304 dec-19), so it decides
// what it draws and the shell keeps owning only the frame. The desktop never
// reaches into the DOM.
//
// The story here is the whole rule, in three legs — the narrowness matters as much
// as the hiding, so the two negative controls are not padding:
//   1. plain browser + Spec  → the agent is there, exactly as today
//   2. desktop shell + Spec  → no agent at all, and the Spec still renders
//   3. desktop shell + a NON-Spec document page → the agent is still there
//
// Seeding goes over the test-only HTTP surface (real services → the std-8 bus),
// navigation is path-based [per std-2], no SQL.
//
// Verifies spec-516 ac-22 (this journey exists and covers the flow) and ac-21 (the
// behaviour it asserts).

import { test, expect, tenantPath, type TestResources } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  seedDoc,
  seedOpenDecision,
  type SeededOrgTenant,
} from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/index.js";
import type { Page } from "@playwright/test";

const AC = [
  "mindset-prod/memex-building-itself/specs/spec-516/acs/ac-21",
  "mindset-prod/memex-building-itself/specs/spec-516/acs/ac-22",
];

interface DesktopSeed {
  tenant: SeededOrgTenant;
  specHandle: string;
  docHandle: string;
  /** Handle of a real decision on the Spec, for the sub-page leg. */
  decisionHandle: string;
}

const test2 = test.extend<{ seed: DesktopSeed }>({
  seed: async ({ resources }: { resources: TestResources }, use) => {
    const slug = resources.slug("j67");
    const tenant = await seedOrgTenant({ slug });
    const spec = await seedSpec({
      memexId: tenant.memexId,
      title: "Desktop Spec layout",
      purpose: "A Spec to open in the desktop two-column tab.",
    });
    // A non-Spec document page, to prove the rule is Spec-scoped and did not
    // quietly strip the agent from every document in the desktop app.
    const doc = await seedDoc({
      memexId: tenant.memexId,
      title: "An ordinary document",
      body: "Not a Spec.",
    });
    // A real decision, so the sub-page leg drives a route that actually exists.
    // NOTE: the web app's Spec child routes are `decisions/:decId` and
    // `issues/:issueId` only — there is no `tasks/:taskId` route, despite the
    // desktop matcher (and spec-516 ac-8) using `…/specs/spec-N/tasks/t-1` as the
    // canonical sub-page example. Rendering two columns for an unreachable URL is
    // harmless, but a journey must exercise a reachable one.
    const decision = await seedOpenDecision({
      memexId: tenant.memexId,
      docId: spec.docId,
      title: "A fork to settle",
      options: [{ label: "One way" }, { label: "The other way" }],
    });
    await use({
      tenant,
      specHandle: spec.handle,
      docHandle: doc.handle,
      decisionHandle: `dec-${decision.seq}`,
    });
  },
});

/**
 * Makes `isDesktopShell()` true for the page by planting the same
 * `window.flutter_inappwebview` shim the real Flutter host injects — installed
 * BEFORE any page script runs, so the very first render already sees the desktop.
 * Every handler resolves `{ ok: true }`; this journey asserts layout, not bridge
 * traffic, and the shell's own handlers are covered in memex-clients.
 */
async function poseAsDesktopShell(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { flutter_inappwebview: unknown }).flutter_inappwebview = {
      callHandler: () => ({ ok: true }),
    };
  });
}

async function goto(page: Page, seed: DesktopSeed, path: string) {
  await page.goto(tenantPath(seed.tenant.namespaceSlug, seed.tenant.memexSlug, path));
}

/** The agent is gone entirely — the panel AND its collapsed strip. */
async function expectNoAgent(page: Page) {
  await expect(page.getByTestId("chat-input")).toHaveCount(0);
  await expect(page.getByTestId("doc-chat-collapsed")).toHaveCount(0);
  await expect(page.getByTestId("chat-collapse")).toHaveCount(0);
}

test2.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-67-spec-516-desktop-spec-layout.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test2.describe("Desktop-hosted Spec hides the web agent (spec-516 dec-10)", () => {
  test2("in a plain browser, a Spec page still shows the web agent", async ({ page, seed }) => {
    await goto(page, seed, `/specs/${seed.specHandle}`);

    // The control leg: nothing about the browser experience changes, so if this
    // ever goes red the rule has leaked out of the desktop.
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Desktop Spec layout" })).toBeVisible();
  });

  test2("inside the desktop shell, a Spec page shows NO web agent", async ({ page, seed }) => {
    await poseAsDesktopShell(page);
    await goto(page, seed, `/specs/${seed.specHandle}`);

    // The Spec itself is there and readable — this is a layout change, not a
    // content one. Waiting on the heading also settles the page before the
    // negative assertions, so they cannot pass merely by running early.
    await expect(page.getByRole("heading", { name: "Desktop Spec layout" })).toBeVisible({
      timeout: 15_000,
    });
    await expectNoAgent(page);
  });

  test2("inside the desktop shell, a Spec SUB-page also shows no web agent", async ({
    page,
    seed,
  }) => {
    await poseAsDesktopShell(page);
    // The desktop renders two columns for Spec sub-pages too (its isSpecUrl matcher
    // counts them as "a Spec is open"), so the two sides must agree — otherwise a
    // sub-page is three columns again. `decisions/:decId` is one of the two child
    // routes the web app actually defines.
    await goto(page, seed, `/specs/${seed.specHandle}/decisions/${seed.decisionHandle}`);

    await expect(page.getByRole("heading", { name: "Desktop Spec layout" })).toBeVisible({
      timeout: 15_000,
    });
    await expectNoAgent(page);
  });

  test2("inside the desktop shell, a NON-Spec document page keeps its agent", async ({
    page,
    seed,
  }) => {
    await poseAsDesktopShell(page);
    await goto(page, seed, `/docs/${seed.docHandle}`);

    // dec-10's scope is Spec pages only. If this goes red the change is broader
    // than the decision authorised.
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 15_000 });
  });
});
