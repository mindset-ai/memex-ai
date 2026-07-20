// Journey 54 — spec-500: "Explore: Memex building itself" — a public + featured
// Memex is surfaced read-only in EVERY authenticated user's switcher, without
// membership, and stays read-only; a MEMBER of the same Memex keeps write access
// via the org channel and never sees a duplicate read-only entry.
//
// User A = dev@memex.ai. The per-test fixture clears dev's org memberships before
// every test, so dev is a genuine NON-MEMBER of the freshly-seeded org B — the
// exact logged-in-non-member path, no signup walk needed.
//
// Legs:
//   (1) ac-2 / ac-5 / ac-13 / ac-1 — non-member A sees B under "Explore", opens
//       it, the read-only badge renders (write is blocked), and the public read
//       succeeds without membership.
//   (2) ac-8 — when A IS an org member of B, B shows under "Your orgs" with
//       write, NOT duplicated under "Explore".

import {
  test,
  expect,
  tenantPath,
  gotoSpecsBoard,
  DEV_EMAIL,
  ensureUser,
  seedOrg,
  setMemexVisibility,
  setFeaturedDemo,
  addOrgMember,
  emitAcEvents,
} from "./helpers/index.js";

const API_URL =
  process.env.E2E_API_URL ??
  `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;

// The genuinely end-to-end ACs this journey verifies. ac-2 (switcher label /
// read-only presentation) is covered by the MemexSwitcher unit test, and ac-8
// (member de-dup) by the users.featured-demo integration test — the journey
// exercises those behaviours but does not need to double-pin them here.
const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-500/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-500/acs/ac-5",
  "mindset-prod/memex-building-itself/specs/spec-500/acs/ac-13",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-65-spec-500-explore-memex.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

// Seed a public + featured Memex owned by a fresh user B (so dev/A is a
// non-member of it). Returns the seeded org for path building + membership legs.
async function seedFeaturedMemex(resources: {
  email: (p: string) => string;
  slug: (p: string) => string;
}) {
  const bEmail = resources.email("explore-owner");
  await ensureUser(bEmail);
  const org = await seedOrg({
    ownerEmail: bEmail,
    slug: resources.slug("explore-b"),
    name: "Explore Org",
    memexName: "Memex building itself",
  });
  await setMemexVisibility({ memexId: org.memexId, visibility: "public" });
  await setFeaturedDemo({ memexId: org.memexId, isFeaturedDemo: true });
  return org;
}

test("a non-member sees the featured Memex under 'Explore', opens it read-only, and can read it without membership", async ({
  page,
  request,
  resources,
}) => {
  const b = await seedFeaturedMemex(resources);

  // A = dev@memex.ai, logged in, non-member of B (fixture cleared memberships).
  await gotoSpecsBoard(page, DEV_EMAIL);

  // ── ac-2: the switcher shows an "Explore" group with B, read-only ───────────
  await page.getByTitle("Switch Memex").click();
  const menu = page.getByTestId("memex-switcher-menu");
  await expect(menu.getByTestId("featured-memexes-header")).toContainText("Explore");
  await expect(menu.getByText("Memex building itself")).toBeVisible();

  // ── ac-1: a logged-in NON-member can READ B (public read, no membership) ────
  const readRes = await request.get(
    `${API_URL}/api/${b.namespaceSlug}/${b.memexSlug}/docs`,
  );
  expect(readRes.ok(), "public memex must be readable by a non-member (ac-1)").toBeTruthy();

  // ── ac-2 / ac-5 / ac-13: open it → read-only badge → write is blocked ───────
  await menu.getByText("Memex building itself").click();
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .toMatch(new RegExp(`^/${b.namespaceSlug}/${b.memexSlug}\\b`));

  // The read-only badge renders for the signed-in non-member (write is blocked;
  // useMemexAccess.canWrite === false → edit/create controls are suppressed).
  await expect(page.getByTestId("readonly-sidebar-badge")).toBeVisible({ timeout: 15_000 });

  // No org-write affordance leaks in: the switcher's "Manage Orgs" aside, there
  // is no "New Spec" create control on a read-only public Memex.
  await expect(page.getByRole("button", { name: /new spec/i })).toHaveCount(0);
});

test("a member of the featured Memex sees it under 'Your orgs' with write — never duplicated under 'Explore'", async ({
  page,
  resources,
}) => {
  const b = await seedFeaturedMemex(resources);

  // Make dev/A an ACTIVE member of B's org — now A reaches B via the org channel.
  await addOrgMember({ orgId: b.orgId, email: DEV_EMAIL, role: "member" });

  await gotoSpecsBoard(page, DEV_EMAIL);
  await page.getByTitle("Switch Memex").click();
  const menu = page.getByTestId("memex-switcher-menu");

  // B appears under "Your orgs" (write access), and the Explore group does NOT
  // duplicate it — ac-8 / the org-channel de-dup.
  await expect(menu.getByText("Your orgs")).toBeVisible();
  await expect(menu.getByText("Memex building itself")).toHaveCount(1);
  await expect(menu.getByTestId("featured-memexes-header")).toHaveCount(0);
});
