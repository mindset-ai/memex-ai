// Journey 63 (spec-496): the standards-map v2 interactions [per std-28].
//
// Seeds a tenant with three standards — two connected by a clause-mention
// edge (seeded through the real clause service, so clause_refs materializes
// [spec-179 dec-3]), one isolated — then drives the WebGL map for real:
//   • cluster colouring applied (connected pair share a hue, loner stays
//     slate — spec-496 dec-2),
//   • single-click focuses a node (card + depth chip), Escape restores
//     (dec-5),
//   • the focus card's "Open standard" navigates to the deep-link route.
//
// WebGL nodes have no DOM, so node screen positions/fills are read from the
// map's read-only e2e hook (window.__standardsMapE2E) and clicks land at real
// canvas coordinates — the genuine user input path through PIXI's events.

import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant, seedStandard, seedClauses } from "./helpers/retained.js";
import type { Page } from "@playwright/test";

const AC = [
  "mindset-prod/memex-building-itself/specs/spec-496/acs/ac-7",
  "mindset-prod/memex-building-itself/specs/spec-496/acs/ac-3",
  "mindset-prod/memex-building-itself/specs/spec-496/acs/ac-6",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-63-spec-496-standards-map-v2.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

type MapHookWindow = Window & {
  __standardsMapE2E?: {
    nodePosition(handle: string): { x: number; y: number } | null;
    nodeFill(handle: string): number | null;
  };
};

/** Screen-space click on a map node via the e2e hook + canvas bounding box. */
async function clickNode(page: Page, handle: string, clicks = 1): Promise<void> {
  const box = await page.getByTestId("standards-map-canvas").boundingBox();
  if (!box) throw new Error("standards-map-canvas has no bounding box");
  const pos = await page.evaluate(
    (h) => (window as MapHookWindow).__standardsMapE2E?.nodePosition(h) ?? null,
    handle,
  );
  if (!pos) throw new Error(`no screen position for ${handle}`);
  await page.mouse.click(box.x + pos.x, box.y + pos.y, { clickCount: clicks });
}

test("cluster colours, click-to-focus + Escape restore, and focus-card navigation", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j63");
  const tenant = await seedOrgTenant({ slug });

  // Three standards. Alpha ↔ Beta get a mention edge: Beta's clause cites
  // Alpha's handle, and the clause write path materializes the ref. Loner
  // stays edgeless (unclustered → neutral slate).
  const alpha = await seedStandard({
    memexId: tenant.memexId,
    title: "Map Alpha",
    body: "Alpha governs the map journey fixture.",
  });
  const beta = await seedStandard({
    memexId: tenant.memexId,
    title: "Map Beta",
    body: "Beta placeholder body.",
  });
  const loner = await seedStandard({
    memexId: tenant.memexId,
    title: "Map Loner",
    body: "No relationships at all.",
  });
  await seedClauses({
    memexId: tenant.memexId,
    sectionId: beta.sectionId,
    clauses: [`Beta pairs with ${alpha.handle} for everything the map fixture needs.`],
  });

  // /standards → map view (the list ⇄ map toggle persists per spec-179).
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/standards"));
  await page.getByTestId("standards-view-map").click();
  await expect(page.getByTestId("standards-map-canvas")).toBeVisible();

  // Wait for the WebGL scene + e2e hook (positions exist once layout settles).
  await page.waitForFunction(
    (h) => Boolean((window as MapHookWindow).__standardsMapE2E?.nodePosition(h)),
    alpha.handle,
    { timeout: 20_000 },
  );

  // ── cluster colouring (dec-2 / ac-3) ─────────────────────────────────────
  const fills = await page.evaluate(
    (handles) => {
      const hook = (window as MapHookWindow).__standardsMapE2E!;
      return handles.map((h) => hook.nodeFill(h));
    },
    [alpha.handle, beta.handle, loner.handle],
  );
  const [alphaFill, betaFill, lonerFill] = fills;
  expect(alphaFill).not.toBeNull();
  // The mention-connected pair share a cluster hue…
  expect(alphaFill).toBe(betaFill);
  // …the isolated standard keeps the neutral slate, which is a different fill.
  expect(lonerFill).not.toBe(alphaFill);

  // ── click-to-focus (dec-5 / ac-6) ────────────────────────────────────────
  await clickNode(page, alpha.handle);
  const card = page.getByTestId("focus-card");
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("focus-card-title")).toContainText(alpha.handle);
  await expect(page.getByTestId("focus-card-title")).toContainText("Map Alpha");

  // Depth chip flips 1 ⇄ 2 without dropping focus.
  await page.getByTestId("focus-depth-2").click();
  await expect(page.getByTestId("focus-depth-2")).toHaveAttribute("aria-pressed", "true");
  await expect(card).toBeVisible();

  // Escape restores the full map.
  await page.keyboard.press("Escape");
  await expect(card).not.toBeVisible();

  // ── focus-card navigation (dec-5: the deep-link path, unchanged) ─────────
  await clickNode(page, alpha.handle);
  await expect(card).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("focus-card-open").click();
  await expect(page).toHaveURL(new RegExp(`/standards/${alpha.handle}(\\?|#|$)`), {
    timeout: 10_000,
  });
});
