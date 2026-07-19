// Journey 45 — spec-393 (workstream D of spec-388): the std-7 UI isolation guard.
//
// THE single biggest security gap the spec-388 review found: std-7 ("unauthorized
// resource access returns 404, not 403 — and leaks nothing about whether the
// resource exists") had NO UI-level guard. This journey closes it.
//
// What the UI actually does (grounded against App.tsx:238-246, spec-393 dec-5):
// a LOGGED-IN NON-MEMBER navigating to another tenant's private memex is
// REDIRECTED by TenantLayout's client-side membership check to their OWN landing
// (computeDefaultLanding → /<personalNs>/<personalMx>/specs) BEFORE any doc fetch
// fires. So there is no "Spec not found" page for the cross-tenant case — there's
// a silent, no-info-leak bounce. That bounce IS std-7-honouring: the same
// redirect fires for ANY non-member namespace, so it reveals nothing about
// whether B's spec exists, and it is NOT a 403.
//
// User A = dev@memex.ai. The per-test fixture clears dev's org memberships before
// every test, so dev is a genuine NON-MEMBER of the freshly-seeded org B — the
// exact logged-in-non-member path, with no signup walk needed.
//
// Three legs (spec-393 dec-5 / ac-7 / ac-8 / ac-15):
//   (a) cross-tenant UI isolation — A is bounced to A's own landing, B's spec
//       title is never visible, and no 403 / "access denied" surface appears.
//   (b) the std-7 SERVER invariant the redirect sits in front of — a request.get
//       to B's spec UUID via the path-prefixed API mount returns 404, NOT 403.
//   (c) the 404 page is a real, reached surface — a member (A) hitting a
//       genuinely-missing handle in A's OWN memex sees "Spec not found".
//
// The journey FAILS if isolation broke: if A could read B's spec, the redirect
// wouldn't fire and B's title would render (a) / the API would 200 (b).

import {
  test,
  expect,
  tenantPath,
  gotoSpecsBoard,
  DEV_EMAIL,
  ensureUser,
  seedOrg,
  seedSpecInMemex,
  setMemexVisibility,
  getPersonalMemexByEmail,
  emitAcEvents,
} from "./helpers/index.js";

const API_URL =
  process.env.E2E_API_URL ??
  `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-393/acs/ac-7",
  "mindset-prod/memex-building-itself/specs/spec-393/acs/ac-8",
  "mindset-prod/memex-building-itself/specs/spec-393/acs/ac-15",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-45-spec-393-std7-isolation.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("std-7: a logged-in non-member cannot reach another tenant's private spec — no 404 leak, no 403", async ({
  page,
  request,
  resources,
}) => {
  // ── Seed user B + B's PRIVATE memex + a private spec ───────────────────────
  const bEmail = resources.email("std7-userb");
  const bUserId = await ensureUser(bEmail);
  const bOrg = await seedOrg({ ownerEmail: bEmail, slug: resources.slug("std7-b") });
  await setMemexVisibility({ memexId: bOrg.memexId, visibility: "private" });

  const secretTitle = `B's Private Secret ${resources.uniq}`;
  const bSpec = await seedSpecInMemex({
    memexId: bOrg.memexId,
    title: secretTitle,
    purpose: "Only B should ever see this.",
    createdByUserId: bUserId,
  });

  // A = dev@memex.ai (auto-authed; the fixture cleared dev's org memberships, so
  // dev is a non-member of B's org). Resolve A's own personal landing so we can
  // assert the redirect target deterministically.
  const aPersonal = await getPersonalMemexByEmail(DEV_EMAIL);
  expect(aPersonal, "dev (A) should have a personal memex").not.toBeNull();

  // Establish A's LOGGED-IN dev session FIRST by landing on A's own board (this
  // is the distinction that matters for std-7: a logged-in non-member, NOT an
  // anonymous visitor — App.tsx routes those two cases differently). Without an
  // active session, navigating straight to B's private tenant would hit the
  // ANONYMOUS probe path (redirect to /login), not the membership-redirect path.
  await gotoSpecsBoard(page, DEV_EMAIL);

  // ── (a) Cross-tenant UI isolation: A is bounced, B's content never shown ────
  await page.goto(tenantPath(bOrg.namespaceSlug, bOrg.memexSlug, `/specs/${bSpec.handle}`), {
    waitUntil: "commit",
  });

  // TenantLayout redirects the logged-in non-member A away from B's tenant to A's
  // OWN landing (computeDefaultLanding → A's personal /home → Trails). Assert
  // the URL leaves B's namespace AND is NOT /login (that would be the anonymous
  // path — proof A really is logged in for this check).
  await expect
    .poll(
      () => new URL(page.url()).pathname,
      { timeout: 15_000, message: "A should be redirected away from B's private tenant" },
    )
    .not.toMatch(new RegExp(`^/${bOrg.namespaceSlug}/${bOrg.memexSlug}\\b`));
  expect(new URL(page.url()).pathname, "A should NOT be bounced to /login (A is logged in)").not.toMatch(
    /^\/login\b/,
  );

  // B's secret title must never render for A.
  await expect(page.getByText(secretTitle)).toHaveCount(0);

  // No authorization-leak surface: std-7 forbids 403 — assert no forbidden/denied copy.
  await expect(page.getByText(/access denied|forbidden|403|not authori[sz]ed/i)).toHaveCount(0);

  // ── (b) The std-7 server invariant: 404, NOT 403, for the cross-tenant UUID ─
  // A's browser carries dev's session; hit B's spec UUID via the path-prefixed
  // API mount under B's namespace. std-7: membership-fail is indistinguishable
  // from not-found → 404, never 403.
  const apiRes = await request.get(
    `${API_URL}/api/${bOrg.namespaceSlug}/${bOrg.memexSlug}/docs/${bSpec.docId}`,
  );
  expect(apiRes.status(), "cross-tenant private spec must 404 for a non-member, not 403").toBe(404);

  // ── (c) The 404 page is a real, reached surface for a member+missing handle ─
  // A navigates to a genuinely-nonexistent handle in A's OWN personal memex.
  await page.goto(
    tenantPath(aPersonal!.namespaceSlug, aPersonal!.memexSlug, "/specs/spec-999999"),
    { waitUntil: "commit" },
  );
  await expect(page.getByText("Spec not found")).toBeVisible({ timeout: 15_000 });
});
