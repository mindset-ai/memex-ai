import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedComment } from "./helpers/retained.js";

// Journey 37 — spec-319 comment-gutter interaction (issues A + B).
//
// A (ac-5): hovering a comment indicator must keep its preview open long enough
//   to read — moving the cursor from the indicator onto the popover keeps it
//   open (the hover bridge + grace-delay), instead of flashing shut.
// B (ac-6 / ac-7, dec-3): the per-section comment-count badge is a status
//   indicator, not a button — it shows no pointer-cursor / clickable affordance.
//
// Real-browser tier (std-28): the flash is a real DOM/hover-geometry effect that
// jsdom can't reproduce; SectionCard.test.tsx pins the bridge logic, this proves
// it in the browser and is the emitting tier for ac-5/6/7.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-319/acs/ac-${n}`;

// A passage whose first word ("Hover") we range-anchor a comment to, so the
// gutter indicator renders on load.
const PASSAGE =
  "Hover the comment indicator in the right margin to read its note without clicking.";

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    [AC(5), AC(6), AC(7)],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-37-spec-319-comment-gutter.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

async function openSeededSpec(page, resources) {
  const tenant = await seedOrgTenant({ slug: resources.slug("j37") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Comment Gutter Spec",
    purpose: PASSAGE,
  });
  // Range-anchor a comment to "Hover" (offsets 0..5) so the section source gets
  // the [^c-Ns]…[^c-Ne] sentinels and the right-edge indicator renders.
  await seedComment({
    memexId: tenant.memexId,
    target: "section",
    targetId: spec.sectionId,
    authorName: "Casey Reviewer",
    content: "Read me on hover, do not make me disappear.",
    anchorStartOffset: 0,
    anchorEndOffset: 5,
  });
  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" },
  );
  await expect(
    page.getByRole("heading", { level: 1, name: /Comment Gutter Spec/ }),
  ).toBeVisible({ timeout: 15_000 });
  return { tenant, spec };
}

test("the per-section comment-count badge is a non-interactive status indicator (ac-6/ac-7)", async ({
  page,
  resources,
}) => {
  await openSeededSpec(page, resources);
  const badge = page.getByTestId("section-comment-count").first();
  await expect(badge).toBeVisible({ timeout: 15_000 });
  // It must not present as clickable: no pointer cursor (it inherited one from
  // the clickable card before the fix), and it is a <span>, not a button.
  await expect(badge).toHaveCSS("cursor", "default");
  expect(await badge.evaluate((el) => el.tagName)).toBe("SPAN");
});

test("hovering a comment indicator keeps the preview open when the cursor moves onto it (ac-5)", async ({
  page,
  resources,
}) => {
  await openSeededSpec(page, resources);
  const indicator = page.locator('[data-indicator-seq]').first();
  await expect(indicator).toBeVisible({ timeout: 15_000 });

  // Hover the indicator → preview appears.
  await indicator.hover();
  const popover = page.getByTestId("comment-popover");
  await expect(popover).toBeVisible({ timeout: 5_000 });
  await expect(popover).toContainText("Read me on hover");

  // Move the cursor OFF the indicator and ONTO the popover — the bridge must keep
  // it open across the gap. Before the fix this flashed shut on mouseleave.
  await popover.hover();
  // Wait well past the grace-delay and assert it is still there (no flicker, no
  // self-dismiss while the cursor rests on it).
  await page.waitForTimeout(600);
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Read me on hover");
});
