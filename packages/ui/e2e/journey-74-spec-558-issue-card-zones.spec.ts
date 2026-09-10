// Journey 74 — spec-558: an Issue card you can read out of [per std-28].
//
// spec-164 dec-4 made the WHOLE Issue card a click-to-toggle accordion. A
// drag-select inside the expanded body still produces a `click` on the card —
// the browser fires it on the nearest common ancestor of the mousedown and
// mouseup targets — so the gesture for reading the body was the gesture that
// closed it, and the text was gone before it could be copied (issue-4).
//
// spec-558 dec-1 splits the card in two: a title strip that responds to clicks
// and a content zone that responds to nothing. This journey is the tier that
// can prove it, because it is the only one that produces a real
// mousedown→drag→mouseup→click sequence at all — jsdom never does.
//
// THE TRAP THIS JOURNEY IS SHAPED AROUND. Two very different things both end
// with "the expanded region is gone": the bug (a real selection, and the click
// collapses the card) and a geometry miss (no selection ever started, so the
// click is an ordinary toggle). After the mouseup they are indistinguishable —
// the collapse unmounts the selected nodes, so the selection reads empty either
// way. Measured while specifying: starting the drag 4px into the paragraph
// lands in its left padding and selects NOTHING, while 6px selects the line.
// A first attempt at this journey went red for exactly that wrong reason and
// "proved" a bug it had not exercised. So the selection is read MID-DRAG,
// before the mouseup, and asserted BEFORE the symptom (ac-4).
//
// Seeding is HTTP-only over the env-gated `__test__` surface, navigation is
// path-based [per std-2 / std-28].

import {
  test,
  expect,
  tenantPath,
  seedIssue,
  emitAcEvents,
} from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";

const SPEC558 = "mindset-prod/memex-building-itself/specs/spec-558";

const ACS_BY_TEST: Record<string, string[]> = {
  "selecting text inside an expanded Issue card leaves it open": [
    `${SPEC558}/acs/ac-1`,
    `${SPEC558}/acs/ac-4`,
  ],
  "the content zone is inert — a click on the body does nothing": [
    `${SPEC558}/acs/ac-3`,
  ],
  "one click on the title strip opens, one click closes": [
    `${SPEC558}/acs/ac-2`,
  ],
  "the two zones read as two zones in both themes, and only the strip reacts to hover":
    [
      `${SPEC558}/acs/ac-5`,
      `${SPEC558}/acs/ac-8`,
      `${SPEC558}/acs/ac-9`,
    ],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TEST[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-74-spec-558-issue-card-zones.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

// Long enough that a horizontal drag across the first line has plenty of
// glyphs to bite into.
const BODY =
  "The quick brown fox jumps over the lazy dog, and then keeps going for a " +
  "good while longer so that a drag across this first line has plenty of " +
  "glyphs to bite into.";

/** Seed a Spec carrying one bodied Issue, open its Issues panel, return it. */
async function openIssuePanel(page, resources, slug: string) {
  const tenant = await seedOrgTenant({ slug: resources.slug(slug) });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Issue Card Zones Spec",
    purpose: "Exercise reading an expanded Issue card.",
  });
  await seedIssue({
    memexId: tenant.memexId,
    docId: spec.docId,
    type: "bug",
    title: "An issue whose body you want to copy",
    body: BODY,
  });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
  );
  await page.locator('[data-tab="verify"]').click();
  // spec-282: Issues live under the unified "Agent Tasks & Issues" sub-tab.
  await page
    .getByRole("button", { name: /Agent Tasks?( \(\d+\))? & Issues?/ })
    .click();
  const panel = page.getByTestId("issue-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

/**
 * Drag-select across the first rendered line of `target` and return what was
 * selected WHILE THE BUTTON WAS STILL DOWN. See the header note: reading it
 * after the mouseup cannot distinguish the bug from a geometry miss.
 *
 * Pass the TEXT's own element, never a padded container: the content zone
 * carries `px-3 py-2.5`, so a gesture measured from its box starts inside the
 * padding and selects nothing. The guard below caught precisely that when the
 * zone gained its padding — which is the whole reason it is a separate
 * assertion. `+6`px, not `+4`: four pixels still lands left of the first
 * glyph and selects nothing (measured).
 */
async function dragSelectMidDrag(page, target): Promise<string> {
  const box = (await target.boundingBox())!;
  const y = box.y + 8;
  await page.mouse.move(box.x + 6, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 12 });
  const selected = await page.evaluate(() =>
    (window.getSelection()?.toString() ?? "").trim(),
  );
  await page.mouse.up();
  return selected;
}

test("selecting text inside an expanded Issue card leaves it open", async ({
  page,
  resources,
}) => {
  const panel = await openIssuePanel(page, resources, "j74a");
  const card = panel.getByTestId("issue-card").first();

  await card.click();
  const content = card.getByTestId("issue-expanded");
  await expect(content).toBeVisible();
  await expect(content).toContainText("quick brown fox");

  // The rendered body paragraph, not the padded zone around it.
  const selected = await dragSelectMidDrag(page, content.locator("p").first());

  // Geometry guard FIRST — prove a real selection existed, so the assertion
  // below can only fail for the reason this journey exists (ac-4).
  expect(
    selected.length,
    "a non-empty text selection should have landed inside the card",
  ).toBeGreaterThan(0);

  // The reported symptom: the read gesture is not a collapse gesture (ac-1).
  await expect(content).toBeVisible();
  await expect(card).toHaveAttribute("data-expanded", "true");
});

test("the content zone is inert — a click on the body does nothing", async ({
  page,
  resources,
}) => {
  const panel = await openIssuePanel(page, resources, "j74b");
  const card = panel.getByTestId("issue-card").first();

  await card.click();
  const content = card.getByTestId("issue-expanded");
  await expect(content).toBeVisible();

  // A plain click in the middle of the body, and a double-click too: neither
  // is a toggle, because the content zone carries no handler at all (ac-3).
  await content.click({ position: { x: 40, y: 8 } });
  await expect(content).toBeVisible();

  await content.dblclick({ position: { x: 40, y: 8 } });
  await expect(content).toBeVisible();
  await expect(card).toHaveAttribute("data-expanded", "true");
});

test("one click on the title strip opens, one click closes", async ({
  page,
  resources,
}) => {
  const panel = await openIssuePanel(page, resources, "j74c");
  const card = panel.getByTestId("issue-card").first();
  // NOTE: this test is the guard for ac-2, not part of the reproduction. On an
  // unfixed card `issue-strip` does not exist yet, so it fails as a missing
  // locator rather than as the symptom — the two tests above are the ones that
  // mutation-check the fix [per std-45 cl-3].
  const strip = card.getByTestId("issue-strip");
  await expect(strip).toBeVisible();

  await strip.click();
  await expect(card.getByTestId("issue-expanded")).toBeVisible();

  // The same gesture closes it — nothing about closing is harder than opening.
  await strip.click();
  await expect(card.getByTestId("issue-expanded")).not.toBeVisible();
});

/**
 * Resolved background of an element, as an [r,g,b] triple.
 *
 * Refuses a transparent background rather than returning one. `getComputedStyle`
 * reports an element with no fill of its own as `rgba(0, 0, 0, 0)`, which parses
 * to black — and black is darker than every token that ships, so a "the content
 * is lighter than the strip" assertion would pass against a zone that has no
 * fill at all. That is not hypothetical: this journey passed both themes that
 * way before the strip was given its own `bg-surface`, comparing a real colour
 * against a transparent one read as black. Each zone must own its fill, and
 * this guard is what makes that unfakeable [per std-45 cl-4].
 */
async function bgOf(locator): Promise<[number, number, number]> {
  const css = await locator.evaluate(
    (el: Element) => getComputedStyle(el).backgroundColor,
  );
  const m = css.match(/rgba?\(([^)]+)\)/);
  expect(m, `expected an rgb() background, got "${css}"`).not.toBeNull();
  const parts = m![1].split(",").map((n) => parseFloat(n));
  const [r, g, b] = parts;
  const alpha = parts.length > 3 ? parts[3] : 1;
  expect(
    alpha,
    `this element has no background of its own (${css}) — it is showing an ancestor's fill through, and a comparison against it measures nothing`,
  ).toBeGreaterThan(0);
  return [r, g, b];
}

const luminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

test("the two zones read as two zones in both themes, and only the strip reacts to hover", async ({
  page,
  resources,
}) => {
  const panel = await openIssuePanel(page, resources, "j74d");
  const card = panel.getByTestId("issue-card").first();
  const strip = card.getByTestId("issue-strip");
  const content = card.getByTestId("issue-expanded");

  // The theme lives in localStorage('memex-theme') and ThemeContext toggles a
  // .dark / .light class on <html>; set it and reload to switch, as journey-26
  // does. BOTH themes are asserted, because a one-theme check is exactly what
  // would let this ship half-broken — and half-broken is the normal outcome
  // here, since the emphasis tokens run in opposite directions in the two
  // themes (ac-5).
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("memex-theme", t), theme);
    await page.reload();
    await page
      .getByRole("button", { name: /Agent Tasks?( \(\d+\))? & Issues?/ })
      .click();
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await strip.click();
    await expect(content).toBeVisible();

    // Measure AT REST — ac-5 states the rule at rest, deliberately.
    //
    // The click leaves the pointer on the strip, and so does a real user's, so
    // this is not a test artifact: it is the state the rule excludes. Measured
    // in the dark theme with the pointer resting on the strip — strip
    // rgb(40,44,52) against content rgb(33,37,43) — the strip is the LIGHTER
    // of the two and the "content recedes" reading inverts. It cannot be
    // fixed by choosing a different hover token: `bg-surface` (#1b1e24) is
    // already the darkest token that ships, so any hover can only lighten.
    // Accepted rather than worked around — the element under the pointer
    // should be the emphasised one — and ac-5 now says "at rest" because that
    // is the boundary the rule actually holds at.
    await page.mouse.move(2, 2);

    const stripBg = await bgOf(strip);
    const contentBg = await bgOf(content);

    // Two zones, not one fill (ac-5) …
    expect(
      contentBg,
      `${theme}: the content zone must not share the strip's fill`,
    ).not.toEqual(stripBg);
    // … and the CONTENT is the half that recedes, in both themes. That is the
    // direction dec-1 chose instead of a darker strip, because no shipped
    // token is darker than the card in the light theme (ac-8).
    expect(
      luminance(contentBg),
      `${theme}: the content zone should recede (be lighter) — strip ${stripBg}, content ${contentBg}`,
    ).toBeGreaterThan(luminance(stripBg));
  }

  // ac-9: the hover promise follows the click target. Hovering the content
  // zone must change nothing — while the whole card carried
  // `hover:bg-card-hover`, hovering lit up the one region that no longer
  // responds to a click, which teaches the user the wrong thing.
  const contentIdle = await bgOf(content);
  const stripIdle = await bgOf(strip);
  await content.hover({ position: { x: 40, y: 8 } });

  // Let the hover STATE settle before reading, and read once.
  //
  // Every assertion below claims a value STAYED put, and that is the one shape
  // polling cannot express: `expect.poll(...).toBe(idle)` succeeds on its first
  // read, which lands before the 150ms `transition-colors` has moved anything.
  // Measured — with the hover group deliberately put back on the card (the
  // defect this asserts against), a polled version of these checks passed all
  // four tests. A poll proves a value BECOMES something; a settle-then-read
  // proves it stayed.
  await page.waitForTimeout(400);

  expect(
    await bgOf(content),
    "hovering the content zone changed its own fill",
  ).toEqual(contentIdle);
  expect(
    await bgOf(strip),
    "hovering the content zone lit up the title strip",
  ).toEqual(stripIdle);

  // The focus icon is the card's OTHER hover cue, and it is not a background —
  // a fill-only check misses it completely. It used to hang off a hover group
  // on the card, so pointing at the inert content zone made a button appear up
  // in the strip. Asserted on computed opacity, not toBeVisible(): Playwright
  // counts an `opacity: 0` element as visible, so the obvious assertion here
  // would pass either way and prove nothing.
  const focusOpacity = () =>
    card
      .getByTestId("issue-focus")
      .evaluate((el: Element) => getComputedStyle(el).opacity);

  // Read once, after the settle above — for the same reason, and this is the
  // assertion that actually pins the defect: the hover group used to sit on the
  // card, so pointing at the inert content zone faded this button in up in the
  // strip.
  expect(
    await focusOpacity(),
    "hovering the content zone revealed the strip's focus icon",
  ).toBe("0");

  // And the vacuity guard [per std-45 cl-4]: the cue must be PRESENT on the
  // strip, not merely absent from the content. Without this, a card that had
  // lost its hover treatment altogether would satisfy every assertion above.
  // Polled, not read once: the zones carry `transition-colors`, so the fill
  // reached ~150ms after the pointer arrives, not on the same tick.
  await strip.hover();
  await expect
    .poll(async () => (await bgOf(strip)).join(","), {
      message: "the title strip should light up under the pointer",
    })
    .not.toBe(stripIdle.join(","));
  await expect
    .poll(focusOpacity, {
      message: "the focus icon should appear when the strip is hovered",
    })
    .toBe("1");
});
