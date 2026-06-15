import { test, expect, bareUrl, emitAcEvents } from "./helpers/index.js";

// Journey 26 — the Memex wordmark recolours with the theme (spec-223 ac-2).
//
// The logo is a single inlined SVG (<Logo/>, dec-2) whose path fills resolve the
// theme-aware `--color-logo` CSS variable (dec-1). This is the runtime claim a
// unit/jsdom test can't make: jsdom doesn't resolve CSS custom properties into a
// computed `fill`. So we drive a real browser — read the computed fill in each
// theme and assert it actually inverts (and isn't the old hardcoded #0E112B navy
// in dark, where it would be invisible).
//
// Theme persists in localStorage('memex-theme') and ThemeContext toggles the
// .dark/.light class on <html>; we set the stored theme and reload to switch.

const AC2 = "mindset-prod/memex-building-itself/specs/spec-223/acs/ac-2";

// index.css: .dark --color-logo: 241 245 249 (near-white); .light: 14 17 43 (navy).
const DARK_FILL = "rgb(241, 245, 249)";
const LIGHT_FILL = "rgb(14, 17, 43)";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC2],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-26-logo-theme.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

async function computedLogoFill(page: import("@playwright/test").Page) {
  return page
    .getByTestId("memex-logo")
    .first()
    .locator("svg path")
    .first()
    .evaluate((el) => getComputedStyle(el as Element).fill);
}

test("the logo fill inverts between dark and light theme (ac-2)", async ({ page }) => {
  // Force dark, then read the computed fill of the header wordmark.
  await page.goto(bareUrl("/"));
  // "/" client-redirects to the default memex's specs page. Wait for that
  // redirect to SETTLE before evaluating, otherwise the localStorage write
  // races the navigation and Playwright throws "Execution context was
  // destroyed, most likely because of a navigation".
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => localStorage.setItem("memex-theme", "dark"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("memex-logo").first()).toBeVisible();

  // Poll, don't sample once: the logo can be visible a frame before its path fill
  // resolves the --color-logo CSS variable, so getComputedStyle().fill reads "" for
  // a moment (spec-278/issue-1 — the journey reddened on that empty read, all 3
  // Playwright retries). expect.poll retries until the dark token settles. Asserting
  // each theme resolves to its own distinct token also proves the recolour inverts
  // (DARK_FILL !== LIGHT_FILL by construction) — stronger than a bare not-equal.
  await expect.poll(() => computedLogoFill(page), { timeout: 10_000 }).toBe(DARK_FILL);

  // Switch to light and re-read.
  await page.evaluate(() => localStorage.setItem("memex-theme", "light"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("memex-logo").first()).toBeVisible();

  // ...and the light token settles to the navy (#0E112B was the old invisible-on-dark bug).
  await expect.poll(() => computedLogoFill(page), { timeout: 10_000 }).toBe(LIGHT_FILL);
});
