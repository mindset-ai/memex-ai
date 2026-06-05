import { test, expect, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, seedDoc, getLatestShareToken } from "./helpers/db.js";

// Journey 5: External Sharing & Viral Growth
// Admin creates a doc, generates a share link, copies URL. A guest visits the link without
// auth, sees the doc with "Created with Memex" branding, and can click "Sign in to comment"
// which sends them to signup with ref parameter for viral attribution.

test("admin shares a doc and a guest sees the read-only view with branding", async ({
  browser,
  resources,
}) => {
  const subdomain = resources.subdomain("j5");
  const accountId = await seedAccount({ subdomain, name: "Viral Co" });
  resources.accountIds.push(accountId);
  await resources.devAsAdmin(accountId);
  const { docId } = await seedDoc({
    accountId,
    handle: "doc-1",
    title: "Publicly Shared Spec",
    purpose: "This document demonstrates viral growth.",
  });

  // === Admin side: generate a share link via the UI ===
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await adminPage.goto(tenantUrl(subdomain, `/docs/${docId}`));
  await expect(adminPage.getByText("Publicly Shared Spec")).toBeVisible({ timeout: 10_000 });

  // Share moved into the per-spec actions menu (post-merge from main).
  // Open the menu first, then click Share.
  await adminPage.getByRole("button", { name: /Actions for Publicly Shared Spec/i }).click();
  await adminPage.getByRole("menuitem", { name: /^Share$/i })
    .or(adminPage.getByRole("button", { name: /^Share$/i }))
    .first()
    .click();
  await adminPage.getByRole("button", { name: /New share link/i }).click();

  // Share link row appears
  await expect(adminPage.getByRole("button", { name: /Copy/i }).first()).toBeVisible({
    timeout: 5000,
  });
  await adminCtx.close();

  // === Guest side: fresh browser context, no cookies/localStorage from admin ===
  const shareToken = await getLatestShareToken(docId);
  expect(shareToken).toBeTruthy();

  const guestCtx = await browser.newContext({ storageState: undefined });
  const guestPage = await guestCtx.newPage();
  // Load the share page WITHOUT auth — SharedDocument lives outside AuthProvider so it
  // renders even without a logged-in user.
  await guestPage.goto(tenantUrl(subdomain, `/share/${shareToken}`));

  // Verify read-only view + branding
  await expect(guestPage.getByText("Publicly Shared Spec")).toBeVisible({ timeout: 10_000 });
  await expect(guestPage.getByText("This document demonstrates viral growth.")).toBeVisible();
  await expect(guestPage.getByText(/Created with/i)).toBeVisible();
  await expect(guestPage.getByText(/Read-only/i)).toBeVisible();

  // "Sign in to comment" button present for guest
  const signInBtn = guestPage.getByRole("button", { name: /Sign in to comment/i });
  await expect(signInBtn.first()).toBeVisible();

  await guestCtx.close();
});
