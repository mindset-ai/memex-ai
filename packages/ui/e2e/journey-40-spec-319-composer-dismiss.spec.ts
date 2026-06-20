import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";

// Journey 40 — spec-319 issue C (ac-8): the comment composer must dismiss when
// you click outside it or start a new selection; clicks inside it are spared.
// Before the fix, the composer only closed on Escape/Cancel/Submit, so it
// lingered over the doc. e2e is the tier — the composer opens via the real
// selection → toolbar → composer flow, which needs selection geometry jsdom lacks.
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-319/acs/ac-${n}`;

const PASSAGE =
  "The quick brown fox jumps over the lazy dog and the comment composer should close when you click away from it or start a new selection.";

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    [AC(8)],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-40-spec-319-composer-dismiss.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

async function openSpecBody(page, resources) {
  const tenant = await seedOrgTenant({ slug: resources.slug("j40") });
  const spec = await seedSpec({ memexId: tenant.memexId, title: "Composer Dismiss Spec", purpose: PASSAGE });
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`), { waitUntil: "commit" });
  await expect(page.getByRole("heading", { level: 1, name: /Composer Dismiss Spec/ })).toBeVisible({ timeout: 15_000 });
  return page.getByTestId("section-body").first();
}

async function selectAndOpenComposer(page, body, f0: number, f1: number) {
  const box = (await body.boundingBox())!;
  await page.mouse.move(box.x + box.width * f0, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * f1, box.y + 8, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId("selection-toolbar")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("selection-toolbar-comment").click();
  await expect(page.getByTestId("comment-composer")).toBeVisible();
}

test("the composer dismisses on a click outside it", async ({ page, resources }) => {
  const body = await openSpecBody(page, resources);
  await selectAndOpenComposer(page, body, 0.05, 0.45);
  const box = (await body.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height - 6);
  await expect(page.getByTestId("comment-composer")).toBeHidden();
});

test("the composer dismisses when a new passage is highlighted", async ({ page, resources }) => {
  const body = await openSpecBody(page, resources);
  await selectAndOpenComposer(page, body, 0.05, 0.45);
  const box = (await body.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height - 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height - 10, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("comment-composer")).toBeHidden();
});

test("clicks INSIDE the composer do not dismiss it", async ({ page, resources }) => {
  const body = await openSpecBody(page, resources);
  await selectAndOpenComposer(page, body, 0.05, 0.45);
  await page.getByTestId("comment-composer-text").click();
  await page.getByTestId("comment-composer-text").fill("still here");
  await expect(page.getByTestId("comment-composer")).toBeVisible();
  await expect(page.getByTestId("comment-composer-text")).toHaveValue("still here");
});
