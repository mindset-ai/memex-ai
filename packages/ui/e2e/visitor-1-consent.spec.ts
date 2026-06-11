// std-28 PR-gate journey for the opt-in consent banner + visitor_id mint (spec-254).
//
// Browser-observable, no DB seeding: the consent banner is mounted app-wide, so it
// shows on the first (pre-auth) load. Decline → no durable visitor cookie (ac-5
// opt-in). Accept → a stable memex_vid UUID cookie that survives a reload (ac-1
// durable + stable across reloads). Path-based nav, env-gated test surface only.

import { test, expect, bareUrl } from "./helpers/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function visitorCookie(page: import("@playwright/test").Page): Promise<string | undefined> {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "memex_vid")?.value;
}

test("declining the consent banner mints no visitor cookie (opt-in)", async ({ page }) => {
  await page.goto(bareUrl("/"));
  const banner = page.getByTestId("visitor-consent");
  await expect(banner).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("visitor-consent-decline").click();
  await expect(banner).toBeHidden();

  expect(await visitorCookie(page)).toBeUndefined();
});

test("accepting mints a stable memex_vid cookie that survives a reload", async ({ page }) => {
  await page.goto(bareUrl("/"));
  await expect(page.getByTestId("visitor-consent")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("visitor-consent-accept").click();
  await expect(page.getByTestId("visitor-consent")).toBeHidden();

  const minted = await visitorCookie(page);
  expect(minted).toMatch(UUID_RE);

  // Reload: the consented banner does not reappear and the id is unchanged.
  await page.reload();
  await expect(page.getByTestId("visitor-consent")).toBeHidden();
  expect(await visitorCookie(page)).toBe(minted);
});
