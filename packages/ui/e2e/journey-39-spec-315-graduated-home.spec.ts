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

// Journey 39 — spec-315: the graduated Home content (iteration 2).
//
//   ac-1  — Home shows a "where you're needed" card for a comment that @-mentions me.
//   ac-2  — Home shows a card per spec I own/worked on; clicking opens the spec.
//   ac-6  — each item is labelled with its Memex (provenance pill).
//   ac-9  — the home-of-value surface sits ABOVE the relocated journey pearls.
//   ac-10 — the spec card is the reused Pulse HotSpecCard.
//   ac-12 — clicking a where-you're-needed item deep-links to the comment (?comment=c-N),
//           landing ON it, not just on the spec.

const AC1 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-1";
const AC2 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-2";
const AC6 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-6";
const AC9 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-9";
const AC10 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-10";
const AC12 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-12";

const TITLE =
  "a graduated user sees their specs (Pulse card) + where they're needed above the pearls, and clicking a mention lands on the highlighted comment";

const seededDocIds: string[] = [];

test.afterEach(async ({}, testInfo) => {
  for (const id of seededDocIds) await deleteDoc(id);
  seededDocIds.length = 0;
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC1, AC2, AC6, AC9, AC10, AC12],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-39-spec-315-graduated-home.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page }) => {
  const userId = await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, true);

  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  if (!memex) throw new Error("dev user has no personal memex");

  // A spec the dev user authored — appears under "Your specs".
  const specA = await seedSpecInMemex({
    memexId: memex.memexId,
    title: "Graduated Home Spec A",
    createdByUserId: userId,
  });
  seededDocIds.push(specA.docId);

  // A comment on specA that @-mentions the dev user — drives "where you're needed".
  const comment = await seedComment({
    memexId: memex.memexId,
    target: "section",
    targetId: specA.sectionId!,
    authorName: "A colleague",
    content: "your expertise is wanted here",
  });
  await seedCommentMention({ memexId: memex.memexId, commentId: comment.commentId, userEmail: DEV_EMAIL });

  await page.goto(bareUrl("/home"));
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("home-canvas")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("home-of-value")).toBeVisible({ timeout: 15_000 });

  // ac-2 / ac-6 / ac-10: the spec renders as the reused Pulse HotSpecCard, with a memex pill,
  // linking to the spec.
  await expect(page.getByTestId("home-specs")).toBeVisible({ timeout: 15_000 });
  const specWrap = page.getByTestId(`home-spec-${specA.docId}`);
  await expect(specWrap).toBeVisible();
  await expect(specWrap.getByTestId("hot-spec-card")).toHaveAttribute(
    "href",
    new RegExp(`/specs/${specA.handle}(\\?|#|$|/)`),
  );
  await expect(specWrap.getByTestId("memex-pill")).toBeVisible();

  // ac-1: the where-you're-needed block shows the mention.
  await expect(page.getByTestId("home-where-needed")).toBeVisible({ timeout: 15_000 });
  const needCard = page.getByTestId(`where-needed-${comment.commentId}`);
  await expect(needCard).toBeVisible();

  // ac-9: the journey pearls are relocated below the home-of-value surface.
  await expect(page.getByTestId("your-journeys")).toBeVisible({ timeout: 15_000 });
  const homeOfValueAbovePearls = await page.evaluate(() => {
    const hov = document.querySelector('[data-testid="home-of-value"]');
    const pearls = document.querySelector('[data-testid="your-journeys"]');
    if (!hov || !pearls) return false;
    return Boolean(hov.compareDocumentPosition(pearls) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(homeOfValueAbovePearls).toBe(true);

  // ac-12: clicking the mention deep-links to the comment (?comment=c-N) and lands ON it.
  await needCard.click();
  await expect(page).toHaveURL(new RegExp(`/specs/${specA.handle}\\?comment=c-${comment.seq}`), {
    timeout: 15_000,
  });
  await expect(page.getByText("your expertise is wanted here")).toBeVisible({ timeout: 15_000 });
});
