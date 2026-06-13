import { test, expect, bareUrl, emitAcEvents } from "./helpers/index.js";
import { seedWhatsNewEntry, clearWhatsNewEntries } from "./helpers/seed.js";

// Journey 22 — What's New ribbon → popup → dismiss (spec-200, std-28 gate).
//
// SCOPE: the end-to-end user-facing surface — a seeded global feed entry makes
// the ribbon slide up; clicking it opens the popup with the entry's What/Why;
// manually closing the popup dismisses the ribbon (it animates "home" into the
// user menu — 2026-06-13 behaviour pass, superseding dec-4's "popup close ≠
// dismiss"), and that dismissal persists across a reload (localStorage). Proves
// the full chain DB → /api/whats-new → React → browser, which the unit/component
// suites can't.
//
// NOTE: the ribbon also auto-dismisses after 6s; the test acts well within that
// window (clicking the ribbon stops the countdown).
//
// The ear → live Specky narration is NOT driven here (real mic + ElevenLabs,
// same as journey-21). This is the std-28 gate; it emits the user-facing scope
// ACs ac-2 (ribbon→popup) and ac-3 (dismiss persists).
//
// The feed is GLOBAL, so we clear it before and after so a seeded entry can't
// leak into other journeys (each test gets a fresh context with no dismiss
// marker → the ribbon would otherwise appear everywhere).

const AC2 = "mindset-prod/memex-building-itself/specs/spec-200/acs/ac-2";
const AC3 = "mindset-prod/memex-building-itself/specs/spec-200/acs/ac-3";

const ENTRY = {
  sourceSpecRef: "mindset-prod/memex-building-itself/specs/spec-journey22",
  sourceSpecHandle: "spec-journey22",
  title: "See what's new at a glance",
  whatText: "A What's New ribbon now announces recent releases.",
  whyText: "You always know what changed and why it matters.",
};

test.beforeAll(async () => {
  await clearWhatsNewEntries();
  await seedWhatsNewEntry(ENTRY);
});

test.afterAll(async () => {
  await clearWhatsNewEntries();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC2, AC3],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-22-whats-new.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("ribbon slides up → popup shows the entry; only its × dismisses it, persisting across reload (ac-2 / ac-3)", async ({
  page,
}) => {
  await page.goto(bareUrl("/"));
  // Bare-domain landing auto-resolves to the dev user's personal-memex Specs board.
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

  // ac-2: the 🎁 ribbon is up; clicking it opens the popup with the entry.
  const ribbon = page.getByTestId("whats-new-ribbon");
  await expect(ribbon).toBeVisible({ timeout: 10_000 });
  await ribbon.click();

  const popup = page.getByTestId("whats-new-popup");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText(ENTRY.title);
  await expect(popup).toContainText(ENTRY.whatText);
  await expect(popup).toContainText(ENTRY.whyText);

  // ac-3 (2026-06-13 behaviour): closing the popup (header ✕) dismisses the
  // ribbon — it animates home into the user menu and is gone.
  await popup.getByRole("button", { name: "Close" }).click();
  await expect(popup).toBeHidden();
  await expect(ribbon).toBeHidden();

  // …and the dismissal persists across a reload (localStorage, per-user).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("whats-new-ribbon")).toBeHidden();
});
