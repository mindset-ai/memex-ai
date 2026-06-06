import { test, expect, tenantPath, bareUrl } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, getLatestShareToken } from "./helpers/retained.js";

// Journey 5: External Sharing & Viral Growth
// An admin opens a Spec, generates a guest share link via the per-Spec Actions
// (⋯) menu → Share → New share link. A guest then visits /share/:token in a
// fresh, unauthenticated browser context and sees the read-only public viewer
// with "Created with Memex" branding + a "Sign in to comment" call-to-action.
//
// Re-based off the account-era harness (dec-2): seeding is HTTP-only (no SQL),
// navigation is path-based [per std-2] — the tenant doc lives at
// /<ns>/<mx>/docs/:id and the public share viewer at the bare /share/:token
// route (SharedDocument lives OUTSIDE AuthProvider, so it renders without a
// logged-in user).

test("admin shares a doc and a guest sees the read-only view with branding", async ({
  browser,
  resources,
}) => {
  const slug = resources.slug("j5");
  const tenant = await seedOrgTenant({ slug });
  const { docId } = await seedSpec({
    memexId: tenant.memexId,
    title: "Publicly Shared Spec",
    purpose: "This document demonstrates viral growth.",
  });

  // === Admin side: generate a guest share link via the UI ===
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await adminPage.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`),
  );
  await expect(
    adminPage.getByRole("heading", { name: "Publicly Shared Spec", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });

  // The guest-share flow lives in the per-Spec Actions (⋯) menu — its "Share"
  // item opens ShareModal (the header "Share" pill opens the page-link dialog
  // instead). Open the menu, click Share, then mint a new share link.
  await adminPage.getByRole("button", { name: /Actions for Publicly Shared Spec/i }).click();
  await adminPage.getByRole("menuitem", { name: "Share", exact: true }).click();
  await adminPage.getByRole("button", { name: /New share link/i }).click();

  // A share-link row appears with a Copy button once the token is minted.
  await expect(adminPage.getByRole("button", { name: /Copy/i }).first()).toBeVisible({
    timeout: 5_000,
  });
  await adminCtx.close();

  // === Guest side: fresh browser context, no cookies/localStorage from admin ===
  const shareToken = await getLatestShareToken(tenant.memexId, docId);
  expect(shareToken).toBeTruthy();

  const guestCtx = await browser.newContext({ storageState: undefined });
  const guestPage = await guestCtx.newPage();
  // /share/:token is a bare (non-tenant) route on the single origin [per std-2].
  await guestPage.goto(bareUrl(`/share/${shareToken}`));

  // Verify read-only view + branding.
  await expect(guestPage.getByText("Publicly Shared Spec").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    guestPage.getByText("This document demonstrates viral growth."),
  ).toBeVisible();
  await expect(guestPage.getByText(/Created with/i)).toBeVisible();
  await expect(guestPage.getByText(/Read-only/i)).toBeVisible();

  // "Sign in to comment" call-to-action present for the guest.
  await expect(
    guestPage.getByRole("button", { name: /Sign in to comment/i }).first(),
  ).toBeVisible();

  await guestCtx.close();
});
