// Journey 64 (spec-498): the Brain — the whole-vault knowledge graph [per std-28].
//
// Seeds a real multi-type vault on the cold DB — the facet vocabulary + a spec
// owning a balloted decision (seed-facet-scenario), two standards joined by a
// clause-mention edge (the real clause write path, spec-179 dec-3), and an OPEN
// drift comment linked to the decision (seed-comment driftDecisionId, dec-4) —
// then drives /brain for real:
//   • type colours (dec-2): facet / standard / spec / decision each wear their
//     std-27 hue, and the drifted standard + drifting decision are ROSE,
//   • the discipline selector (dec-7): selecting a discipline focuses it
//     like a click and glides it into view,
//   • click-to-focus + the focus card's Open action landing on the decision's
//     canonical deep link (/specs/:spec/decisions/:dec).
//
// WebGL nodes have no DOM, so positions/fills come from the page's read-only
// e2e hook (window.__brainMapE2E) and clicks land at real canvas coordinates.

import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedStandard,
  seedClauses,
  seedComment,
  seedFacetScenario,
} from "./helpers/retained.js";
import type { Page } from "@playwright/test";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-498";
const AC = [
  `${SPEC}/acs/ac-12`, // the journey itself
  `${SPEC}/acs/ac-11`, // driftDecisionId passthrough exercised end-to-end
  `${SPEC}/acs/ac-1`, // the Brain surface renders the knowledge graph
  `${SPEC}/acs/ac-3`, // drift is unmissably red
];

// The rose failure hue (std-27), either theme — "red" pinned without guessing
// which theme the journey user lands in.
const ROSE = [0xfb7185, 0xf43f5e];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-64-spec-498-brain.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

type BrainHookWindow = Window & {
  __brainMapE2E?: {
    nodePosition(handle: string): { x: number; y: number } | null;
    nodeFill(handle: string): number | null;
  };
};

async function nodeFill(page: Page, handle: string): Promise<number | null> {
  return page.evaluate(
    (h) => (window as BrainHookWindow).__brainMapE2E?.nodeFill(h) ?? null,
    handle,
  );
}

/** Screen-space click on a Brain node via the e2e hook + canvas bounding box. */
async function clickNode(page: Page, handle: string): Promise<void> {
  const box = await page.getByTestId("brain-map-canvas").boundingBox();
  if (!box) throw new Error("brain-map-canvas has no bounding box");
  const pos = await page.evaluate(
    (h) => (window as BrainHookWindow).__brainMapE2E?.nodePosition(h) ?? null,
    handle,
  );
  if (!pos) throw new Error(`no screen position for ${handle}`);
  await page.mouse.click(box.x + pos.x, box.y + pos.y);
}

test("type colours, rose drift, discipline selector, and focus-card deep link", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j64");
  const tenant = await seedOrgTenant({ slug });

  // The facet vocabulary + a spec owning a balloted, RESOLVED decision — it
  // must pass the graph's resolved default filter (dec-7: no filter UI).
  const scenario = await seedFacetScenario({ memexId: tenant.memexId, resolve: true });
  const decisionHandle = `dec-${scenario.decisionSeq}`;

  // Two standards; Clean cites Drifty so a mention edge materializes through
  // the real clause write path.
  const clean = await seedStandard({
    memexId: tenant.memexId,
    title: "Clean Standard",
    body: "Nothing wrong here.",
  });
  const drifty = await seedStandard({
    memexId: tenant.memexId,
    title: "Drifty Standard",
    body: "About to be contradicted.",
  });
  await seedClauses({
    memexId: tenant.memexId,
    sectionId: clean.sectionId,
    clauses: [`Everything defers to ${drifty.handle} on this.`],
  });

  // The open drift comment, LINKED to the decision (dec-4): the real comments
  // write path stamps drift_decision_id, which is exactly what draws the rose
  // decision→standard edge and turns both endpoints rose.
  await seedComment({
    memexId: tenant.memexId,
    target: "section",
    targetId: drifty.sectionId,
    commentType: "drift",
    driftDecisionId: scenario.decisionId,
    content: "The resolved decision contradicts this clause.",
  });

  // ── the Brain surface (ac-1): nav entry + the map renders ────────────────
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/brain"));
  await expect(page.getByTestId("brain-map-canvas")).toBeVisible();
  await expect(page.getByTestId("primary-nav").getByText("Trails")).toBeVisible();
  await expect(page.getByTestId("brain-legend")).toBeVisible();

  await page.waitForFunction(
    (h) => Boolean((window as BrainHookWindow).__brainMapE2E?.nodePosition(h)),
    clean.handle,
    { timeout: 20_000 },
  );

  // ── colour encoding (the resolved decision is present from first paint) ──
  const cleanFill = await nodeFill(page, clean.handle);
  const driftyFill = await nodeFill(page, drifty.handle);
  const facetFill = await nodeFill(page, scenario.facetKey);
  expect(cleanFill).not.toBeNull();
  expect(facetFill).not.toBeNull();
  // The drifted standard is ROSE (ac-3) — its type hue is overridden…
  expect(ROSE).toContain(driftyFill);
  // …while the clean standard and the facet wear their own, distinct hues.
  expect(cleanFill).not.toBe(driftyFill);
  expect(facetFill).not.toBe(cleanFill);
  expect(ROSE).not.toContain(cleanFill);
  expect(ROSE).not.toContain(facetFill);
  // The drifting (resolved) decision is on the map and rose too (ac-3)…
  expect(ROSE).toContain(await nodeFill(page, decisionHandle));
  // …with its owning spec beside it in its own (non-rose) hue.
  const specFill = await nodeFill(page, scenario.specHandle);
  expect(specFill).not.toBeNull();
  expect(ROSE).not.toContain(specFill);

  // ── the discipline selector (dec-7): select ≙ click + glide into view ────
  await page.getByTestId("brain-discipline-select").selectOption(scenario.facetKey);
  const disciplineCard = page.getByTestId("brain-focus-card");
  await expect(disciplineCard).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("brain-focus-title")).toContainText("Discipline");
  // Escape restores, and the selector returns to its placeholder.
  await page.keyboard.press("Escape");
  await expect(disciplineCard).not.toBeVisible();
  await expect(page.getByTestId("brain-discipline-select")).toHaveValue("");

  // ── click-to-focus + the deep link (ac-4 via the card's Open action) ─────
  await clickNode(page, decisionHandle);
  const card = page.getByTestId("brain-focus-card");
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("brain-focus-title")).toContainText("Decision");
  await expect(page.getByTestId("brain-focus-title")).toContainText(decisionHandle);

  // Escape restores the full map…
  await page.keyboard.press("Escape");
  await expect(card).not.toBeVisible();

  // …and Open lands on the decision's canonical deep link (std-10).
  await clickNode(page, decisionHandle);
  await expect(card).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("brain-focus-open").click();
  await expect(page).toHaveURL(
    new RegExp(`/specs/${scenario.specHandle}/decisions/${decisionHandle}(\\?|#|$)`),
    { timeout: 10_000 },
  );
});
