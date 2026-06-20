import {
  test,
  expect,
  bareUrl,
  emitAcEvents,
  ensureUser,
  setUserName,
  setIdentityConfirmed,
  getPersonalMemexByEmail,
  seedSpecInMemex,
  deleteDoc,
  DEV_EMAIL,
  DEV_NAME,
} from "./helpers/index.js";

// Journey 37 — spec-315: the graduated Home content.
//
//   ac-2 — Home shows one card per spec the user recently worked on; clicking it opens
//          the full spec.
//   ac-6 — each card is labelled with the Memex it belongs to (provenance pill) and
//          links into that Memex's spec.
//   ac-9 — layout: the home-of-value surface (where-you're-needed + specs-in-flight)
//          sits ABOVE the journey pearls, which are relocated to the bottom (dec-3).
//
// The spec-315 surface (specs-in-flight + pills + the pearls-at-bottom reorder) renders
// for any user on /home regardless of journey graduation — graduation only governs the
// expanded journey LAYER (spec-312's concern, covered by journey-35). So this journey
// drives the spec-315 content directly with an identity-confirmed dev user + seeded specs.

const AC2 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-2";
const AC6 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-6";
const AC9 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-9";

const TITLE =
  "a user on Home sees their specs in flight with memex provenance, above the relocated journey pearls, and can click through";

// Track seeded docs so reruns + sibling tests don't accumulate residue in the dev
// user's personal memex.
const seededDocIds: string[] = [];

test.afterEach(async ({}, testInfo) => {
  for (const id of seededDocIds) await deleteDoc(id);
  seededDocIds.length = 0;
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC2, AC6, AC9],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-37-spec-315-graduated-home.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page }) => {
  const userId = await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, true);

  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  if (!memex) throw new Error("dev user has no personal memex");

  // Two specs the dev user authored — they appear under "Your specs in flight".
  const specA = await seedSpecInMemex({
    memexId: memex.memexId,
    title: "Graduated Home Spec A",
    createdByUserId: userId,
  });
  const specB = await seedSpecInMemex({
    memexId: memex.memexId,
    title: "Graduated Home Spec B",
    createdByUserId: userId,
  });
  seededDocIds.push(specA.docId, specB.docId);

  await page.goto(bareUrl("/home"));
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("home-canvas")).toBeVisible({ timeout: 15_000 });

  // The home-of-value surface and the specs-in-flight block render.
  await expect(page.getByTestId("home-of-value")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("home-specs-in-flight")).toBeVisible({ timeout: 15_000 });

  // ac-2: a card for a seeded spec is present. ac-6: it carries a memex provenance pill.
  const cardA = page.getByTestId(`spec-in-flight-${specA.docId}`);
  await expect(cardA).toBeVisible();
  await expect(cardA.getByTestId("memex-pill")).toBeVisible();

  // ac-9: the journey pearls are RELOCATED below the home-of-value surface.
  await expect(page.getByTestId("your-journeys")).toBeVisible({ timeout: 15_000 });
  const homeOfValueAbovePearls = await page.evaluate(() => {
    const hov = document.querySelector('[data-testid="home-of-value"]');
    const pearls = document.querySelector('[data-testid="your-journeys"]');
    if (!hov || !pearls) return false;
    return Boolean(hov.compareDocumentPosition(pearls) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(homeOfValueAbovePearls).toBe(true);

  // ac-2: clicking a card opens that spec.
  await cardA.click();
  await expect(page).toHaveURL(new RegExp(`/specs/${specA.handle}(\\?|#|$|/)`), {
    timeout: 15_000,
  });
});
