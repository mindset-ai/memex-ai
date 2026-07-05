import {
  test,
  expect,
  bareUrl,
  getPersonalMemexByEmail,
  seedSpecInMemex,
  DEV_EMAIL,
  emitAcEvents,
} from "./helpers/index.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-458";

// ac-1 is a page-in-browser scope claim, so its verification signal comes from
// this journey (the vitest surface can't render the SPA). Emits pass AND fail
// per the ac-emission discipline.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  if (!testInfo.title.startsWith("an anonymous visitor")) return;
  await emitAcEvents(
    [`${SPEC}/acs/ac-1`],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-57-live-page.spec.ts::${testInfo.title}`,
    testInfo.duration ?? 0,
  );
});

// Journey 57 — the public /live proof-of-life page (spec-458).
//
// The page is fully public (rendered outside AuthProvider, the /share pattern):
// an ANONYMOUS visitor — fresh browser context, no token, no session — opens
// /live and sees the headline, world map, totals band, and ticker with no login
// wall and no redirect (ac-1). Nothing user-generated may appear: we seed a spec
// with a distinctive title and assert it reaches neither the page nor the
// /api/live payload (ac-2). The page carries the unlisted noindex directive
// (ac-8/ac-12) and the ?demo=1 preview is loudly labelled (ac-4 honesty).

test("an anonymous visitor sees the live page — no login, no redirect, nothing user-generated", async ({
  browser,
  resources,
}) => {
  // Real user-generated content to prove absence against (ac-2). The seeded
  // title is unique per run so a leak can't false-negative on stale data.
  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  expect(memex).not.toBeNull();
  const SECRET_TITLE = `Leak probe ${resources.uniq} XZQV`;
  await seedSpecInMemex({ memexId: memex!.memexId, title: SECRET_TITLE });

  // Fresh context: no storage, no cookies, no auth of any kind (ac-1).
  const anonContext = await browser.newContext();
  const page = await anonContext.newPage();
  try {
    await page.goto(bareUrl("/live"));

    // No login wall: the URL never leaves /live.
    await expect(page).toHaveURL(/\/live(\?|#|$)/);

    // The four page zones render (dec-1 cascade means ONE of the three headline
    // tiers is up — all three variants end in a phrase the h1 always carries).
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("img", { name: /world map/i })).toBeVisible();
    await expect(page.getByText("Happening now", { exact: false })).toBeVisible();
    await expect(page.getByText("Anonymous by construction", { exact: false })).toBeVisible();

    // Unlisted (ac-8/ac-12): the robots noindex meta is attached while mounted.
    await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);

    // ac-2: the seeded title appears NOWHERE — page text or API payload.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(SECRET_TITLE);
    expect(bodyText).not.toContain(resources.uniq);
    const api = await page.request.get(bareUrl("/api/live"));
    expect(api.status()).toBe(200);
    expect(await api.text()).not.toContain(SECRET_TITLE);

    // ac-4/ac-5: the disclosure copy names humans AND agents.
    expect(bodyText.toLowerCase()).toContain("agent");
  } finally {
    await anonContext.close();
  }
});

test("?demo=1 renders loudly-labelled synthetic data (never silently)", async ({ browser }) => {
  const anonContext = await browser.newContext();
  const page = await anonContext.newPage();
  try {
    await page.goto(bareUrl("/live?demo=1"));
    await expect(page.getByText("DEMO DATA")).toBeVisible({ timeout: 15_000 });
    // The demo payload exercises the above-floor headline (ac-9's 'now' tier).
    await expect(
      page.getByRole("heading", { level: 1 }).filter({ hasText: "right now" }),
    ).toBeVisible();
  } finally {
    await anonContext.close();
  }
});
