import { test, expect, bareUrl } from "./helpers/fixtures.js";
import {
  getPersonalMemexByEmail,
  setUserName,
  seedSpecInMemex,
  deleteDoc,
} from "./helpers/db.js";

// Journey 18 (spec-64 t-6): the global ⌘K search palette, end-to-end in a real
// browser. The component test (SearchPalette.test.tsx) runs under jsdom, which
// can't faithfully model the things this journey locks down — the OS-level
// ⌘K/Ctrl+K hotkey reaching the window listener (ac-16), cmdk's Radix dialog
// owning Esc-to-close + focus restoration (ac-8), and the roving arrow-key
// selection driving a real react-router navigation (ac-9/ac-10).
//
// Auth + tenant: we drive the dev session the same way journey-10 does — go to
// the bare domain and let PostLoginRouter resolve dev@memex.ai into its personal
// memex (namespace `dev` / memex `personal`). No login screen, no subdomain. The
// palette queries GET /api/<ns>/<mx>/search for whatever memex the URL resolves
// to, so we seed a distinctively-titled Spec straight into that memex (via the
// post-0038 memex-native seed helper) to make the query deterministic.
//
// AC coverage:
//   ac-16  ⌘K / Ctrl+K opens the palette from any authenticated tenant page.
//   ac-9   typing a Spec title surfaces a result row with a kind badge.
//   ac-10  ArrowDown moves the roving selection, Enter navigates to the hit.
//   ac-8   Esc closes the dialog AND restores focus to the prior element.

// A title unlikely to collide with anything already in the local dev memex, so
// the query resolves to exactly our seeded Spec.
const SPEC_TITLE = "Zephyr Quokka Search Beacon";

test.describe("Journey 18 — global ⌘K search palette", () => {
  let docId: string;
  let nsSlug: string;
  let mxSlug: string;
  let specHandle: string;

  test.beforeEach(async () => {
    // The dev fixture has already seeded dev@memex.ai + its personal memex.
    const memex = await getPersonalMemexByEmail("dev@memex.ai");
    if (!memex) throw new Error("dev@memex.ai has no personal memex — fixture setup drifted");
    nsSlug = memex.namespaceSlug;
    mxSlug = memex.memexSlug;
    // The server's dev-user bypass auto-creates dev@memex.ai WITHOUT a display
    // name → the app shows the onboarding profile screen instead of the tenant.
    // Give it a name so we land on the Specs board. (The shared account-based
    // fixture that normally does this writes to the dropped pre-0038 schema.)
    await setUserName("dev@memex.ai", "Dev User");
    // A unique handle so reruns don't collide on the per-memex (memex_id, handle)
    // unique constraint if a prior afterEach failed to clean up.
    specHandle = `spec-j18-${Date.now().toString(36)}`;
    ({ docId } = await seedSpecInMemex({
      memexId: memex.memexId,
      handle: specHandle,
      title: SPEC_TITLE,
      purpose: "Zephyr Quokka Search Beacon — purpose body for the global search journey.",
    }));
  });

  test.afterEach(async () => {
    if (docId) await deleteDoc(docId);
  });

  // The keyboard chord differs by platform. The app-level listener (App.tsx
  // GlobalSearchHost) toggles on metaKey||ctrlKey + 'k', so cover both: Meta on
  // macOS, Control elsewhere. Cross-platform-safe.
  const HOTKEY = process.platform === "darwin" ? "Meta+k" : "Control+k";

  test("⌘K opens the palette, a typed Spec title surfaces a result, Enter navigates, Esc restores focus", async ({
    page,
  }) => {
    await page.goto(bareUrl("/"));
    // Land on the dev tenant's Specs board before touching the palette so we're
    // demonstrably on an authenticated tenant page (ac-16 reachable-from-anywhere).
    await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
      timeout: 15_000,
    });

    // ── ac-16: the global hotkey opens the dialog ──────────────────────────
    await page.keyboard.press(HOTKEY);
    const dialog = page.getByRole("dialog", { name: "Search this memex" });
    await expect(dialog).toBeVisible();

    // ── ac-9: typing the Spec title surfaces a result row with a kind badge ──
    await page.getByPlaceholder(/Search specs/i).fill(SPEC_TITLE);

    // The same Spec is eligible in two tiers — the jumpTo title-substring arm
    // ("Jump to") and the content FTS arm ("Specs"). Both render a `spec`-kind
    // row pointing at the same path. Assert at least one spec row appears, then
    // that it shows the "Spec" kind badge and sits under a labelled group.
    const specRow = dialog
      .locator('[data-testid="search-result"][data-kind="spec"]')
      .filter({ hasText: SPEC_TITLE })
      .first();
    await expect(specRow).toBeVisible({ timeout: 10_000 });
    await expect(specRow).toContainText("Spec"); // kind badge
    // It lands in the expected tier: the jumpTo arm renders it under "Jump to"
    // (title-substring), which is the top group. Assert the group heading is
    // present in the listbox.
    await expect(dialog.getByText("Jump to", { exact: true })).toBeVisible();

    // The hit's canonical path is built server-side from the memex slugs.
    const expectedPath = `/${nsSlug}/${mxSlug}/specs/${specHandle}`;
    await expect(specRow).toHaveAttribute("data-path", `${nsSlug}/${mxSlug}/specs/${specHandle}`);

    // ── ac-10: ArrowDown moves the roving selection, Enter navigates ─────────
    // cmdk auto-selects the first option; ArrowDown proves the roving selection
    // moves, leaving exactly one option aria-selected. Every row that surfaces
    // for this unique title points at the SAME seeded Spec (the jumpTo and
    // content tiers share its path), so Enter navigates to that path regardless
    // of which of those rows the selection settled on.
    await page.keyboard.press("ArrowDown");
    await expect(dialog.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
    await page.keyboard.press("Enter");

    // The palette navigates to '/' + hit.path and closes. Assert both the URL
    // and that the spec-detail page rendered (h1 = the Spec title, same anchor
    // journey-15 uses for the detail layout).
    await expect(page).toHaveURL(new RegExp(`${expectedPath}$`));
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("heading", { name: SPEC_TITLE, level: 1 })).toBeVisible({
      timeout: 15_000,
    });

    // ── ac-8: reopen, focus a known element, Esc closes + restores focus ─────
    // This is the real-browser proof jsdom can't give: Radix's dialog traps
    // focus on open and must hand it back to the previously-focused element on
    // close. We tag a focusable element on the page, focus it, open the palette
    // (focus moves into the input), press Esc, and assert focus came back.
    const backLink = page.getByRole("link", { name: /All specs/i });
    await expect(backLink).toBeVisible();
    await backLink.focus();
    await expect(backLink).toBeFocused();

    await page.keyboard.press(HOTKEY);
    const reopened = page.getByRole("dialog", { name: "Search this memex" });
    await expect(reopened).toBeVisible();
    // Focus has moved off the back link into the dialog: the search input is now
    // focused. We do NOT assert `backLink` is "not focused" directly — Radix's
    // focus trap aria-hides the page behind the open dialog, so the link leaves the
    // accessibility tree and isn't queryable by role while the palette is open. The
    // input-focused check is the positive proof that focus moved into the dialog.
    await expect(page.getByPlaceholder(/Search specs/i)).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(reopened).not.toBeVisible();
    // ac-8: focus is restored to the element that was focused before opening.
    await expect(backLink).toBeFocused();
  });
});
