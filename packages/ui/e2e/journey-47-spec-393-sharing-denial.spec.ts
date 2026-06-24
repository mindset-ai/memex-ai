// Journey 47 — spec-393 (workstream D of spec-388): external-sharing DENIAL.
//
// journey-5 covers the valid-token happy path (the read-only viewer + branding).
// The spec-388 review found the DENIAL side untested at the UI: a revoked or
// malformed share token should surface a clear refusal, not a blank page or a
// leak. This journey closes that gap (spec-393 dec-3 / ac-11).
//
// The public viewer (SharedDocument.tsx, OUTSIDE AuthProvider) maps a
// ShareAccessError to one of two refusals:
//   - reason 'revoked'  → heading "Link revoked"  + "This link has been revoked."
//   - any other reason  → heading "Share link invalid" + the unknown-token copy.
//
// Token states asserted: REVOKED (mint a valid token, revoke it via the admin
// DELETE endpoint, replay it) and MALFORMED/UNKNOWN (navigate to a garbage
// token). EXPIRED is out of scope: share tokens carry no expiry the test surface
// can seed (retained.ts seedShareToken has no expiry param), and an expired token
// would fall through to the same "Share link invalid" refusal anyway.

import { test, expect, bareUrl, DEV_EMAIL, ensureUser } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedShareToken } from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/emit-ac.js";

const API_URL =
  process.env.E2E_API_URL ??
  `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;

const AC11 = ["mindset-prod/memex-building-itself/specs/spec-393/acs/ac-11"];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    AC11,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-47-spec-393-sharing-denial.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("a revoked share token shows the 'Link revoked' refusal in the public viewer", async ({
  browser,
  resources,
}) => {
  // Seed an org owned by dev so the admin DELETE (revoke) is authorised, a spec,
  // and a valid share token for it.
  await ensureUser(DEV_EMAIL);
  const tenant = await seedOrgTenant({ slug: resources.slug("denial-revoked") });
  const { docId } = await seedSpec({
    memexId: tenant.memexId,
    title: "Revocable Shared Spec",
    purpose: "This share link will be revoked.",
  });
  const { shareId, token } = await seedShareToken({ memexId: tenant.memexId, docId });

  // Sanity: the token resolves before revocation (guest sees the read-only view).
  const guestCtxOk = await browser.newContext({ storageState: undefined });
  const guestPageOk = await guestCtxOk.newPage();
  await guestPageOk.goto(bareUrl(`/share/${token}`));
  await expect(guestPageOk.getByText("Revocable Shared Spec").first()).toBeVisible({
    timeout: 10_000,
  });
  await guestCtxOk.close();

  // Revoke via the admin DELETE endpoint (dev is an admin/member of this org, so
  // the path-prefixed share-management route authorises). The admin browser
  // context carries dev's auto-auth session.
  const adminCtx = await browser.newContext();
  const revokeRes = await adminCtx.request.delete(
    `${API_URL}/api/${tenant.namespaceSlug}/${tenant.memexSlug}/docs/shares/${shareId}`,
    { headers: { Host: "memex.ai" } },
  );
  expect(revokeRes.status(), "admin revoke should succeed").toBe(200);
  await adminCtx.close();

  // Guest replays the now-revoked token → the viewer shows the 'Link revoked' refusal.
  const guestCtx = await browser.newContext({ storageState: undefined });
  const guestPage = await guestCtx.newPage();
  await guestPage.goto(bareUrl(`/share/${token}`));
  await expect(guestPage.getByRole("heading", { name: "Link revoked" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(guestPage.getByText("This link has been revoked.")).toBeVisible();
  // The doc content must NOT render for a revoked link.
  await expect(guestPage.getByText("This share link will be revoked.")).toHaveCount(0);
  await guestCtx.close();
});

test("a malformed / unknown share token shows the 'Share link invalid' refusal", async ({
  browser,
}) => {
  const guestCtx = await browser.newContext({ storageState: undefined });
  const guestPage = await guestCtx.newPage();
  // A token that was never minted → the server can't resolve it → ShareAccessError
  // reason 'unknown' → the viewer's "Share link invalid" refusal.
  await guestPage.goto(bareUrl(`/share/this-token-was-never-minted-zzz999`));
  await expect(guestPage.getByRole("heading", { name: "Share link invalid" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    guestPage.getByText(/This share link is not valid/i),
  ).toBeVisible();
  await guestCtx.close();
});
