// Journey 66 — spec-502: the value-first onboarding wizard.
//
// A user viewing the featured demo Memex (building-itself, surfaced by spec-500)
// sees the context-aware Explore companion with a "Create your own Memex" CTA;
// clicking it opens the wizard, which drives them name → console demo → the
// agent-connect hard gate (with an explicit defer/capture branch, and NO
// equal-footing "author in the browser" fork).
//
// Legs:
//   (1) ac-1 / ac-16 — the companion appears over the featured Memex with its
//       synopsis + the standing "Create your own Memex" CTA.
//   (2) ac-2 / ac-7 / ac-8 — the CTA opens the wizard; name → demo → connect
//       reaches the hard gate; the defer branch is present and there is no
//       browser-authoring escape.

import {
  test,
  expect,
  DEV_EMAIL,
  gotoSpecsBoard,
  ensureUser,
  seedOrg,
  setMemexVisibility,
  setFeaturedDemo,
  emitAcEvents,
} from "./helpers/index.js";

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-502/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-502/acs/ac-16",
  "mindset-prod/memex-building-itself/specs/spec-502/acs/ac-2",
  "mindset-prod/memex-building-itself/specs/spec-502/acs/ac-7",
  "mindset-prod/memex-building-itself/specs/spec-502/acs/ac-8",
  // spec-508 Part 3: the first-landing welcome that morphs into the companion.
  "mindset-prod/memex-building-itself/specs/spec-508/acs/ac-8",
  "mindset-prod/memex-building-itself/specs/spec-508/acs/ac-9",
];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-66-spec-502-onboarding-wizard.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

async function seedFeaturedMemex(resources: {
  email: (p: string) => string;
  slug: (p: string) => string;
}) {
  const bEmail = resources.email("wizard-owner");
  await ensureUser(bEmail);
  const org = await seedOrg({
    ownerEmail: bEmail,
    slug: resources.slug("wizard-b"),
    name: "Wizard Demo Org",
    memexName: "Memex building itself",
  });
  await setMemexVisibility({ memexId: org.memexId, visibility: "public" });
  await setFeaturedDemo({ memexId: org.memexId, isFeaturedDemo: true });
  return org;
}

test("the Explore companion invites you to create your own, and the CTA opens the connect-gated wizard", async ({
  page,
  resources,
}) => {
  const b = await seedFeaturedMemex(resources);

  // dev (a non-member) opens the featured Memex via the switcher's "Explore" group.
  await gotoSpecsBoard(page, DEV_EMAIL);
  await page.getByTitle("Switch Memex").click();
  const menu = page.getByTestId("memex-switcher-menu");
  await expect(menu.getByTestId("featured-memexes-header")).toContainText("Explore");
  await menu.getByText("Memex building itself").click();

  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
    .toMatch(new RegExp(`^/${b.namespaceSlug}/${b.memexSlug}\\b`));

  // ── spec-508 ac-8 / ac-9: a FIRST landing opens on the centered welcome, which
  // morphs into the corner companion on OK (this is a cold-DB run, so nothing is
  // recorded in localStorage yet — the welcome is shown) ─────────────────────────
  const welcome = page.getByTestId("explore-welcome");
  await expect(welcome).toBeVisible({ timeout: 15_000 });
  await welcome.getByTestId("explore-welcome-ok").click();
  await expect(welcome).toBeHidden();

  // ── ac-1 / ac-16: the context-aware companion is present with its synopsis + CTA ──
  const companion = page.getByTestId("explore-companion");
  await expect(companion).toBeVisible({ timeout: 15_000 });
  await expect(companion.getByTestId("explore-companion-synopsis")).toBeVisible();
  const cta = companion.getByTestId("create-your-own-memex-cta");
  await expect(cta).toHaveText(/create your own memex/i);

  // ── ac-2: the CTA opens the wizard as a modal over the live Memex (not a route
  // change), so the user keeps their place behind it and can close back out ──────
  await cta.click();
  await expect(page.getByTestId("wizard-modal")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("wizard-name-step")).toBeVisible();

  // name → demo
  await page.getByTestId("wizard-name-continue").click();
  await expect(page.getByTestId("wizard-console-demo")).toBeVisible();

  // demo → connect (the hard gate) — the reused CreateSpecStep renders its
  // connect card (copyable install instructions + coding-agent chips).
  await page.getByTestId("wizard-demo-continue").click();
  await expect(page.getByTestId("connect-stage")).toBeVisible({ timeout: 15_000 });

  // ── ac-8: the defer/capture branch is present (defer, not lose) ─────────────
  await expect(page.getByTestId("wizard-defer-connect")).toBeVisible();

  // ── ac-7: no equal-footing "author in the browser" escape at the connect step ─
  await expect(page.getByRole("button", { name: /in the browser|author here|skip the agent/i })).toHaveCount(0);
});
