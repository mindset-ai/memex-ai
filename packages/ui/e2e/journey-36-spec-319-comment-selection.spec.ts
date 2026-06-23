import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";

// Journey 36 — spec-319 (dec-1): selecting a passage in a spec section must
// reliably surface the add-comment affordance (the SelectionToolbar), invariant
// to WHERE the mouse gesture ends.
//
// The bug: detection was wired to an element-scoped `onMouseUp` on the section
// body, so a drag that RELEASES OUTSIDE the body (an everyday overshoot past or
// below the text) never fired the handler and the toolbar never appeared — while
// the identical selection released INSIDE the body did show it. That is the
// "I cannot bank on it" coin-flip. The fix makes detection document-level
// (selectionchange), so it is independent of the release point.
//
// This is the std-28 e2e proof: a real browser selection with a real release
// point — exactly the DOM/selection coverage gap that mocked jsdom unit tests
// miss (the unit suite covers the pure offset/range mapping). The control case
// (release INSIDE) guards against regressing the path that already worked.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-319/acs/ac-${n}`;

const PASSAGE =
  "The quick brown fox jumps over the lazy dog while the selection toolbar should appear above this very passage every single time.";

test.afterEach(async ({}, testInfo) => {
  // Scope ACs: ac-1 (reliable on every attempt) + ac-2 (invariant to where the
  // gesture ends). dec-1 implementation ACs: ac-3 (a gesture ending OUTSIDE the
  // body still surfaces the toolbar) + ac-4 (a gesture ending INSIDE still does —
  // the working path preserved under the document-level detector). This journey
  // exercises both ends, so it is the emitting tier for all four (the UI unit
  // job carries no emission key; e2e is where coverage lands).
  await emitAcEvents(
    [AC(1), AC(2), AC(3), AC(4)],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-36-spec-319-comment-selection.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

/** Open a freshly-seeded one-section spec and return the section body locator. */
async function openSpecBody(page, resources) {
  const tenant = await seedOrgTenant({ slug: resources.slug("j36") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Comment Selection Spec",
    purpose: PASSAGE,
  });
  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" },
  );
  await expect(
    page.getByRole("heading", { level: 1, name: /Comment Selection Spec/ }),
  ).toBeVisible({ timeout: 15_000 });
  const body = page.getByTestId("section-body").first();
  await expect(body).toBeVisible({ timeout: 15_000 });
  // The passage must have rendered before we try to select it.
  await expect(body).toContainText("quick brown fox", { timeout: 15_000 });
  return body;
}

/**
 * Drag-select across the first rendered line of `body`, releasing the mouse at
 * `release`: "inside" ends the gesture within the body box; "outside" ends it
 * well below the body box (the overshoot the bug dropped). Asserts a non-empty
 * selection actually landed, so a geometry miss fails loudly rather than masking
 * the toolbar assertion.
 */
async function dragSelect(page, body, release: "inside" | "outside") {
  const box = (await body.boundingBox())!;
  const startX = box.x + 6;
  const startY = box.y + 8;
  const endX = box.x + box.width * 0.7;
  const insideY = box.y + 8;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Extend across the first line.
  await page.mouse.move(endX, insideY, { steps: 12 });
  if (release === "outside") {
    // Keep extending and release BELOW the body's border-box (outside it).
    await page.mouse.move(endX, box.y + box.height + 60, { steps: 8 });
  }
  await page.mouse.up();

  const selected = await page.evaluate(() =>
    (window.getSelection()?.toString() ?? "").trim(),
  );
  expect(selected.length, "a non-empty text selection should have landed").toBeGreaterThan(0);
}

test("a drag that releases OUTSIDE the section body still surfaces the add-comment toolbar (dec-1)", async ({
  page,
  resources,
}) => {
  const body = await openSpecBody(page, resources);
  await dragSelect(page, body, "outside");
  // The whole point of the fix: release point is irrelevant; the toolbar shows.
  await expect(page.getByTestId("selection-toolbar")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("selection-toolbar-comment")).toBeVisible();
});

test("a drag that releases INSIDE the section body surfaces the toolbar (regression guard)", async ({
  page,
  resources,
}) => {
  const body = await openSpecBody(page, resources);
  await dragSelect(page, body, "inside");
  await expect(page.getByTestId("selection-toolbar")).toBeVisible({ timeout: 5_000 });
});
