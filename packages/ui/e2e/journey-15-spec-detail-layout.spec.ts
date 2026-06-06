import { test, expect, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, seedDoc, seedSection } from "./helpers/db.js";

// Journey 15: Spec detail page layout. Locks in the structure shipped with
// the design refresh — header actions live in the top nav (not the body), tabs
// render as pills, and the segments outline is a floating sidebar that scrolls
// the document into view.
//
// Navigates straight to /docs/{docId} so the homepage layout (owned by another
// workstream) is not on the critical path.

test.describe("Spec detail layout", () => {
  test("renders new layout: header slot, pill tabs, floating outline", async ({
    page,
    resources,
  }) => {
    const subdomain = resources.subdomain("j15");
    const accountId = await seedAccount({ subdomain, name: "Layout Test" });
    resources.accountIds.push(accountId);
    await resources.devAsAdmin(accountId);

    const { docId } = await seedDoc({
      accountId,
      handle: "doc-1",
      title: "Layout Spec",
      purpose: "Spec for layout regression testing.",
      docType: "spec",
    });
    await seedSection({ docId, title: "Design Approach", seq: 2, content: "Design body." });
    await seedSection({ docId, title: "Testing Plan", seq: 3, content: "Testing body." });
    await seedSection({ docId, title: "Rollout Plan", seq: 4, content: "Rollout body." });

    await page.goto(tenantUrl(subdomain, `/docs/${docId}`));
    await expect(page.getByRole("heading", { name: "Layout Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });

    // Top nav (global doc header) hosts the action group. Anchor on the back
    // link so we're definitively inside the global header, not the body.
    const topNav = page.locator("header").filter({ hasText: "All specs" });
    await expect(topNav.getByLabel("Spec status")).toBeVisible();
    await expect(topNav.getByRole("button", { name: "Share", exact: true })).toBeVisible();
    await expect(topNav.getByRole("button", { name: "Download Spec" })).toBeVisible();
    await expect(topNav.getByRole("button", { name: /Actions for Layout Spec/ })).toBeVisible();

    // Body header is now title + handle + docType only — no duplicated actions.
    const bodyHeader = page.getByRole("heading", { name: "Layout Spec", level: 1 }).locator("xpath=..");
    await expect(bodyHeader.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
    await expect(bodyHeader.getByRole("button", { name: "Download Spec" })).toHaveCount(0);
    await expect(bodyHeader.getByLabel("Spec status")).toHaveCount(0);

    // Pill tabs — Narrative active by default, switching works.
    await expect(page.getByRole("button", { name: /^Narrative/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Decisions/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Tasks/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Comments/ })).toBeVisible();

    await page.getByRole("button", { name: /^Decisions/ }).click();
    await expect(page).toHaveURL(/\/docs\//);
    await page.getByRole("button", { name: /^Narrative/ }).click();

    // Floating outline (DocOutline) — Segments label + section list visible.
    const outline = page.locator("nav").filter({ has: page.getByRole("link", { name: /Purpose/ }) });
    await expect(page.getByText("Segments", { exact: true })).toBeVisible();
    await expect(outline.getByRole("link", { name: /Purpose/ })).toBeVisible();
    await expect(outline.getByRole("link", { name: /Design Approach/ })).toBeVisible();
    await expect(outline.getByRole("link", { name: /Testing Plan/ })).toBeVisible();
    await expect(outline.getByRole("link", { name: /Rollout Plan/ })).toBeVisible();

    // Click an outline link → that section scrolls into view.
    await outline.getByRole("link", { name: /Rollout Plan/ }).click();
    const rollout = page.locator("#section-4");
    await expect(rollout).toBeInViewport();
  });

  test("Share button opens coming-soon dialog", async ({ page, resources }) => {
    const subdomain = resources.subdomain("j15s");
    const accountId = await seedAccount({ subdomain, name: "Share Test" });
    resources.accountIds.push(accountId);
    await resources.devAsAdmin(accountId);

    const { docId } = await seedDoc({
      accountId,
      handle: "doc-1",
      title: "Share Test Spec",
      docType: "spec",
    });

    await page.goto(tenantUrl(subdomain, `/docs/${docId}`));
    await expect(page.getByRole("heading", { name: "Share Test Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });

    const topNav = page.locator("header").filter({ hasText: "All specs" });
    await topNav.getByRole("button", { name: "Share", exact: true }).click();

    await expect(page.getByText("Coming soon.")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByText("Coming soon.")).not.toBeVisible();
  });

  test("Download button opens markdown download dialog", async ({ page, resources }) => {
    const subdomain = resources.subdomain("j15d");
    const accountId = await seedAccount({ subdomain, name: "Download Test" });
    resources.accountIds.push(accountId);
    await resources.devAsAdmin(accountId);

    const { docId } = await seedDoc({
      accountId,
      handle: "doc-1",
      title: "Download Test Spec",
      docType: "spec",
    });

    await page.goto(tenantUrl(subdomain, `/docs/${docId}`));
    await expect(page.getByRole("heading", { name: "Download Test Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });

    const topNav = page.locator("header").filter({ hasText: "All specs" });
    await topNav.getByRole("button", { name: "Download Spec" }).click();

    await expect(page.getByRole("heading", { name: "Download as Markdown" })).toBeVisible();
  });

  test("status dropdown updates Spec status", async ({ page, resources }) => {
    const subdomain = resources.subdomain("j15st");
    const accountId = await seedAccount({ subdomain, name: "Status Test" });
    resources.accountIds.push(accountId);
    await resources.devAsAdmin(accountId);

    const { docId } = await seedDoc({
      accountId,
      handle: "doc-1",
      title: "Status Test Spec",
      docType: "spec",
    });

    await page.goto(tenantUrl(subdomain, `/docs/${docId}`));
    await expect(page.getByRole("heading", { name: "Status Test Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });

    const topNav = page.locator("header").filter({ hasText: "All specs" });
    const statusSelect = topNav.getByLabel("Spec status");
    await expect(statusSelect).toHaveValue("draft");

    await statusSelect.selectOption("specify");
    await expect(statusSelect).toHaveValue("specify");

    // Status persists across reload (server-backed, not just local state).
    await page.reload();
    await expect(page.getByRole("heading", { name: "Status Test Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("header").filter({ hasText: "All specs" }).getByLabel("Spec status")).toHaveValue("specify");
  });
});
