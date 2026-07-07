import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant, seedDoc } from "./helpers/retained.js";

// Journey 58 — spec-438: the cold-start Standards bootstrap CTA (std-28 gate).
//
// The empty Standards page surfaces a "Bootstrap standards from your codebase"
// PromptButton (dec-1, ac-4/ac-7): a copy-to-clipboard handoff to the developer's
// own coding agent — the kickoff prose lives in the Scaffold node
// `bootstrap-standards`, never inlined in the client (std-15/std-23).
//
// The spec-438 component test is source-introspection (it reads StandardList.tsx
// and asserts the PromptButton wiring); it never renders the page. This journey is
// the missing std-28 leg: route -> React -> rendered empty state -> the live
// handoff dialog + real clipboard write, which jsdom can't prove.
//
// Emits spec-438 ac-4 (the bootstrap doorbell is an EMPTY-state affordance — present
// when there are no standards, absent once there are) and ac-7 (copy-to-clipboard
// handoff to the coding agent).

const AC438 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-438/acs/ac-${n}`;

const ACS_BY_TEST: Record<string, string[]> = {};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const acRefs = ACS_BY_TEST[testInfo.title] ?? [];
  if (acRefs.length === 0) return;
  await emitAcEvents(
    acRefs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-58-spec-438-bootstrap-cta.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

// ── Test 1: the empty state renders the CTA and its live copy handoff ──
const TEST_1 =
  "empty Standards page renders the bootstrap CTA and copies the prompt to the clipboard (ac-4, ac-7)";
ACS_BY_TEST[TEST_1] = [AC438(4), AC438(7)];

test(TEST_1, async ({ page, resources }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  // A fresh org Memex has no standards — the default-standards seed is
  // personal-only (spec-438 dec-4) — so its Standards list shows the cold-start
  // empty state (the list view is the default; a fresh browser has no stored
  // "map" preference).
  const tenant = await seedOrgTenant({ slug: resources.slug("j58a") });

  // std-28: path-based nav to the tenant-scoped Standards list.
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/standards"));

  // ac-4: the empty state renders — the "no standards yet" copy + the bootstrap CTA.
  await expect(page.getByText("No standards yet.")).toBeVisible({ timeout: 15_000 });
  const cta = page.getByTestId("standards-bootstrap-cta");
  await expect(cta).toBeVisible();
  const trigger = cta.getByRole("button", {
    name: /bootstrap standards from your codebase/i,
  });
  await expect(trigger).toBeVisible();

  // ac-7: activating the CTA opens the handoff dialog (portaled to <body>). The
  // prompt is shown verbatim as a copyable artifact, and "Copy prompt" writes it
  // to the real clipboard and confirms.
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("pre")).toBeVisible();
  await dialog.getByRole("button", { name: "Copy prompt" }).click();
  await expect(dialog.getByTestId("copy-confirmation")).toBeVisible();

  // Prove the REAL clipboard path (not just markup): the clipboard now carries the
  // Scaffold-sourced bootstrap prompt — a substantial, standards-oriented prompt,
  // not an empty string.
  const clip = (await page.evaluate(() => navigator.clipboard.readText())).trim();
  expect(clip.length).toBeGreaterThan(100);
  expect(clip.toLowerCase()).toContain("standard");
});

// ── Test 2: the CTA is an empty-state affordance — it is gone once standards exist ──
const TEST_2 =
  "the bootstrap CTA is absent once the Memex has standards (ac-4 — empty-state-scoped)";
ACS_BY_TEST[TEST_2] = [AC438(4)];

test(TEST_2, async ({ page, resources }) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j58b") });
  await seedDoc({
    memexId: tenant.memexId,
    title: "Standard A",
    body: "A seeded standard so the list is non-empty.",
    docType: "standard",
  });

  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/standards"));

  // The seeded standard renders as a card…
  await expect(page.getByText("Standard A")).toBeVisible({ timeout: 15_000 });
  // …and the cold-start CTA + its empty-state copy are gone (ac-4: the doorbell is
  // scoped to the empty state, never shown alongside real standards).
  await expect(page.getByTestId("standards-bootstrap-cta")).toHaveCount(0);
  await expect(page.getByText("No standards yet.")).toHaveCount(0);
});
