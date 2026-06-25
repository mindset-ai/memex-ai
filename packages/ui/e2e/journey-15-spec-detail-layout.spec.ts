import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedSection, tenantApiUrl } from "./helpers/retained.js";

// Journey 15: Spec detail page layout. Locks in the structure shipped with the
// design refresh — header actions live in the top nav (not the body), tabs
// render as pills, and the segments outline is a floating sidebar that scrolls
// the document into view.
//
// Re-based off the account-era harness (dec-2): HTTP-only seeding via the org
// tenant surface, path-based navigation [per std-2].
//
// ⚠ RE-BASE / retired-UI notes (surfaced as blockers, not silently patched):
//   • The header `aria-label="Spec status"` <select> is GONE — the spec-159
//     redesign replaced it with the PostureDropdown (Editing/Reviewing) pill and
//     an in-page PhaseTabBar. The original layout test's `getByLabel("Spec status")`
//     assertions + the whole "status dropdown updates Spec status" test reference
//     retired UI; that test is removed here and flagged.
//   • The toolbar "Share" button no longer opens a "Coming soon." dialog — it
//     opens ShareSpecDialog (the Spec's canonical URL + a Copy button). The Share
//     test below asserts the CURRENT dialog; the old "Coming soon." assertion is
//     retired and flagged.

test.describe("Spec detail layout", () => {
  test("renders new layout: header slot, pill tabs, floating outline", async ({
    page,
    resources,
  }) => {
    const slug = resources.slug("j15");
    const tenant = await seedOrgTenant({ slug });
    const { docId, sectionId } = await seedSpec({
      memexId: tenant.memexId,
      title: "Layout Spec",
      purpose: "Spec for layout regression testing.",
    });
    // Distinct sectionType per call — addSection rejects a duplicate type on the
    // same doc, and createDocDraft already seeded an overview/"context" section.
    await seedSection({ memexId: tenant.memexId, docId, title: "Design Approach", content: "Design body.", sectionType: "design" });
    await seedSection({ memexId: tenant.memexId, docId, title: "Testing Plan", content: "Testing body.", sectionType: "testing" });
    await seedSection({ memexId: tenant.memexId, docId, title: "Rollout Plan", content: "Rollout body.", sectionType: "rollout" });
    // spec-194: seed one comment so the Comments-tab filter rows render (they're
    // hidden when the doc has no comments).
    {
      const res = await fetch(
        tenantApiUrl(tenant.namespaceSlug, tenant.memexSlug, `comments/section/${sectionId}`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ authorName: "Alex Rivera", content: "A note for the filter row." }),
        },
      );
      expect(res.ok).toBe(true);
    }

    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));
    await expect(page.getByRole("heading", { name: "Layout Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });

    // Top nav (global doc header) hosts the action group. Anchor on the back
    // link so we're definitively inside the global header, not the body.
    const topNav = page.locator("header").filter({ hasText: "All specs" });
    await expect(topNav.getByRole("button", { name: "Share", exact: true })).toBeVisible();
    await expect(topNav.getByRole("button", { name: "Download Spec" })).toBeVisible();
    await expect(topNav.getByRole("button", { name: /Actions for Layout Spec/ })).toBeVisible();

    // Body header is now title + handle + docType only — no duplicated actions.
    const bodyHeader = page.getByRole("heading", { name: "Layout Spec", level: 1 }).locator("xpath=..");
    await expect(bodyHeader.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
    await expect(bodyHeader.getByRole("button", { name: "Download Spec" })).toHaveCount(0);

    // Plan-phase sub-tabs (post spec-164/159 redesign; spec-233 relabelled the
    // prose tab "Spec" → "Narrative"): the Narrative sub-tab active by default,
    // then Decisions & ACs, then Comments. Tasks moved under the Build PHASE tab
    // (not a sub-tab pill here), so it's no longer in this row.
    await expect(page.getByRole("button", { name: /^Narrative\b/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Decisions & ACs/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Comments/ })).toBeVisible();

    // Comments filter rows: the comment-type chip row is gone (spec-185); the
    // author-kind row is present and renamed People→Humans (spec-194), sharing
    // one combined row with the Open/Resolved/All status row.
    await page.getByRole("button", { name: /^Comments/ }).click();
    await expect(page.getByTestId("comment-filter-chips")).toHaveCount(0);
    await expect(page.getByTestId("author-filter")).toBeVisible();
    await expect(page.getByTestId("author-filter-human")).toHaveText("Humans");
    await expect(page.getByTestId("status-filter")).toBeVisible();

    await page.getByRole("button", { name: /^Decisions & ACs/ }).click();
    // A spec opened via /docs/:id canonicalises to /specs/:id (DocDocument route).
    // Switching sub-tabs is in-page — assert we're still on the spec, not that the
    // path is /docs/.
    await expect(page).toHaveURL(/\/specs\//);
    await page.getByRole("button", { name: /^Narrative\b/ }).click();

    // Floating outline (DocOutline) — Segments label + section list visible. The
    // seeded spec's first section is the createDocDraft "Overview" (not "Purpose").
    const outline = page.locator("nav").filter({ has: page.getByRole("link", { name: /Overview/ }) });
    await expect(page.getByText("Segments", { exact: true })).toBeVisible();
    await expect(outline.getByRole("link", { name: /Overview/ })).toBeVisible();
    await expect(outline.getByRole("link", { name: /Design Approach/ })).toBeVisible();
    await expect(outline.getByRole("link", { name: /Testing Plan/ })).toBeVisible();
    await expect(outline.getByRole("link", { name: /Rollout Plan/ })).toBeVisible();

    // Click an outline link → that section scrolls into view.
    await outline.getByRole("link", { name: /Rollout Plan/ }).click();
    const rollout = page.locator("#section-4");
    await expect(rollout).toBeInViewport();
  });

  test("Share button opens the canonical-URL share dialog", async ({ page, resources }) => {
    const slug = resources.slug("j15s");
    const tenant = await seedOrgTenant({ slug });
    const { docId } = await seedSpec({ memexId: tenant.memexId, title: "Share Test Spec" });

    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));
    await expect(page.getByRole("heading", { name: "Share Test Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });

    const topNav = page.locator("header").filter({ hasText: "All specs" });
    await topNav.getByRole("button", { name: "Share", exact: true }).click();

    // CURRENT behaviour (spec-159): the header Share opens ShareSpecDialog — a
    // dialog labelled "Share this spec" with the page URL + a Copy button. The
    // pre-redesign "Coming soon." placeholder is retired (flagged).
    const dialog = page.getByRole("dialog", { name: "Share this spec" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Copy$/ })).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();
  });

  test("Download button opens markdown download dialog", async ({ page, resources }) => {
    const slug = resources.slug("j15d");
    const tenant = await seedOrgTenant({ slug });
    const { docId } = await seedSpec({ memexId: tenant.memexId, title: "Download Test Spec" });

    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));
    await expect(page.getByRole("heading", { name: "Download Test Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });

    const topNav = page.locator("header").filter({ hasText: "All specs" });
    await topNav.getByRole("button", { name: "Download Spec" }).click();

    await expect(page.getByRole("heading", { name: "Download as Markdown" })).toBeVisible();
  });

  // RETIRED: the original "status dropdown updates Spec status" test drove a
  // header <select aria-label="Spec status">. That control no longer exists — the
  // spec-159 redesign replaced it with the in-page PhaseTabBar + PostureDropdown.
  // Reproducing phase-control coverage against the current UI is out of scope for
  // a re-base (it's a different surface); surfaced as a blocker for a fresh
  // journey rather than rewritten here.
});
