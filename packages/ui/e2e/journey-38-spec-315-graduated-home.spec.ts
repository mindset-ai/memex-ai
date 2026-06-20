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
import { seedComment } from "./helpers/retained.js";
import { seedCommentMention } from "./helpers/seed.js";

// Journey 38 — spec-315: the graduated Home content.
//
//   ac-1 — Home shows a "where you're needed" card for a comment that @-mentions the
//          user, linking into that spec.
//   ac-2 — Home shows one card per spec the user recently worked on; clicking it opens
//          the full spec.
//   ac-6 — each card is labelled with the Memex it belongs to (provenance pill).
//   ac-9 — layout: the home-of-value surface (where-you're-needed + specs-in-flight)
//          sits ABOVE the journey pearls, which are relocated to the bottom (dec-3).
//
// The spec-315 surface renders for any user on /home regardless of journey graduation —
// graduation only governs the expanded journey LAYER (spec-312's concern, journey-35).

const AC1 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-1";
const AC2 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-2";
const AC6 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-6";
const AC9 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-9";

const TITLE =
  "a user on Home sees where they're needed + their specs in flight with memex provenance, above the relocated journey pearls, and can click through";

// Track seeded docs so reruns + sibling tests don't accumulate residue in the dev
// user's personal memex. Deleting a doc cascades to its sections → comments → mentions.
const seededDocIds: string[] = [];

test.afterEach(async ({}, testInfo) => {
  for (const id of seededDocIds) await deleteDoc(id);
  seededDocIds.length = 0;
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC1, AC2, AC6, AC9],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-38-spec-315-graduated-home.spec.ts::${testInfo.title}`,
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

  // A comment on specA's section that @-mentions the dev user — drives "where you're needed".
  const comment = await seedComment({
    memexId: memex.memexId,
    target: "section",
    targetId: specA.sectionId!,
    authorName: "A colleague",
    content: "your expertise is wanted here",
  });
  await seedCommentMention({
    memexId: memex.memexId,
    commentId: comment.commentId,
    userEmail: DEV_EMAIL,
  });

  await page.goto(bareUrl("/home"));
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("home-canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("home-of-value")).toBeVisible({ timeout: 15_000 });

  // ac-1: the "where you're needed" block shows the mention, with a provenance pill.
  await expect(page.getByTestId("home-where-needed")).toBeVisible({ timeout: 15_000 });
  const needCard = page.getByTestId(`where-needed-${comment.commentId}`);
  await expect(needCard).toBeVisible();
  await expect(needCard.getByTestId("memex-pill")).toBeVisible();

  // ac-2 / ac-6: a spec-in-flight card with a memex provenance pill.
  await expect(page.getByTestId("home-specs-in-flight")).toBeVisible({ timeout: 15_000 });
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
