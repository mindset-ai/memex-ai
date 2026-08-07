import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedSupersede, seedTags } from "./helpers/retained.js";
import { installAcEmission } from "./helpers/emit-ac.js";

// spec-521 t-4/t-5 — the PR-gate e2e journeys for "archive must mean forget" (std-28).
//
// §3 names three journeys, and all three are here. They drive the REAL UI against a
// freshly-seeded isolated tenant; every mutation runs the actual REST routes and
// services, and seeding goes through the env-gated /api/__test__ surface (never raw
// SQL), so seeded writes emit on the bus exactly like real ones.
//
//   1. Archive a Spec WITH A REASON → it leaves the board → it appears in the archive
//      view with reason and actor → restore it → it returns to its original phase and
//      column with content intact.                                            (ac-4, ac-5)
//   2. A draft Spec appears in the tag-filtered listing — the ac-6 regression, i.e.
//      the query that returned nothing.                                       (ac-6)
//   3. Supersede one Spec by another → the predecessor's page shows the banner and
//      links to the successor → the successor shows the mirror.               (ac-14)
//
// The agent-visibility ACs (ac-1/ac-2/ac-3) are deliberately NOT here: they are not
// browser journeys, and §3 says so. They are asserted at the MCP and in-app-agent
// layers in packages/server (archived-docs.spec-521.integration.test.ts), separately
// per surface — one surface having a guard the other lacked is the whole defect.

const SPEC = "mindset-prod/memex-building-itself/specs/spec-521";
const AC_RESTORE = `${SPEC}/acs/ac-4`;
const AC_ARCHIVE_VIEW = `${SPEC}/acs/ac-5`;
const AC_DRAFT_VISIBLE = `${SPEC}/acs/ac-6`;
const AC_BANNER = `${SPEC}/acs/ac-14`;

const T1 =
  "a human archives a Spec with a reason, finds it in the archive view with reason and actor, and restores it intact";
const T2 = "a draft Spec appears in the tag-filtered board listing";
const T3 =
  "a superseded Spec shows the banner linking to its successor, and the successor shows the mirror";

installAcEmission(test, import.meta.url, {
  [T1]: [AC_RESTORE, AC_ARCHIVE_VIEW],
  [T2]: [AC_DRAFT_VISIBLE],
  [T3]: [AC_BANNER],
});

// ══════════════════════════════════════════════════════════════════════════════
// Journey 1 — archive with a reason, see it, restore it (ac-4, ac-5)
// ══════════════════════════════════════════════════════════════════════════════

test(T1, async ({ page, resources }) => {
  const slug = resources.slug("j67a");
  const tenant = await seedOrgTenant({ slug });
  const doomed = await seedSpec({
    memexId: tenant.memexId,
    title: "Voice guide content pipeline",
    purpose: "The premise of this Spec is about to disappear.",
  });
  // A second Spec that must be untouched throughout — proving the archive removed one
  // row rather than emptying the board.
  await seedSpec({
    memexId: tenant.memexId,
    title: "Survivor spec",
    purpose: "Still live.",
  });

  const boardUrl = tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs");
  const REASON = "premise gone — voice loop removed";

  // ── 1) The board shows both Specs. ──────────────────────────────────────────
  await page.goto(boardUrl);
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Voice guide content pipeline")).toBeVisible();
  await expect(page.getByText("Survivor spec")).toBeVisible();

  // ── 2) Archive it through the real dialog, giving a reason. ──────────────────
  // The card's overflow menu. Scope to the card so the menu button resolves uniquely.
  const card = page
    .getByTestId("spec-card")
    .filter({ hasText: "Voice guide content pipeline" });
  await card
    .getByRole("button", { name: "Actions for Voice guide content pipeline" })
    .click();
  await page.getByRole("menuitem", { name: "Archive" }).click();

  // ac-4: the confirm asks WHY, and states what archiving now actually does — not the
  // old "hidden from the board", which stopped being the whole truth when archiving
  // began withholding the Spec from every agent surface.
  await expect(page.getByText(/Claude will stop reading this Spec entirely/)).toBeVisible();
  await expect(page.getByText(/You can restore it any time/)).toBeVisible();
  await page.getByLabel(/Reason/i).fill(REASON);
  await page.getByRole("button", { name: "Archive", exact: true }).click();

  // ── 3) It leaves the board; the other Spec stays. ───────────────────────────
  // Scoped to the CARD, not the page: the dialog quotes the title too, so a bare
  // page-level text assertion is ambiguous while it is still closing.
  await expect(
    page.getByTestId("spec-card").filter({ hasText: "Voice guide content pipeline" }),
  ).toHaveCount(0, { timeout: 10_000 });
  await expect(
    page.getByTestId("spec-card").filter({ hasText: "Survivor spec" }),
  ).toHaveCount(1);

  // ── 4) It appears in the archive view, with reason and actor (ac-5). ────────
  await page.getByTestId("archive-view-link").click();
  await expect(page.getByRole("heading", { name: /Archived specs/i })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Voice guide content pipeline" });
  await expect(row).toBeVisible({ timeout: 10_000 });
  // WHY — the load-bearing column.
  await expect(row).toContainText(REASON);
  // BY WHOM — the dev user who performed the archive, stamped at write (std-32).
  await expect(row).toContainText(/dev|Dev/);
  // The phase it was in when archived. Archiving is orthogonal to phase, so this is
  // the Spec's unchanged status — which is also why restore has no phase to reinstate.
  await expect(row).toContainText("draft");

  // ── 5) Restore it (ac-4). ───────────────────────────────────────────────────
  await row.getByRole("button", { name: /Restore/i }).click();
  await expect(row).toBeHidden({ timeout: 10_000 });

  // ── 6) It is back on the board, in its original column, content intact. ─────
  await page.goto(boardUrl);
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId("spec-card").filter({ hasText: "Voice guide content pipeline" }),
  ).toHaveCount(1, { timeout: 10_000 });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${doomed.handle}`),
  );
  await expect(
    page.getByText("The premise of this Spec is about to disappear."),
  ).toBeVisible({ timeout: 15_000 });
  // And the restored Spec carries no residual archive banner or state.
  await expect(page.getByText(/ARCHIVED/)).toBeHidden();
});

// ══════════════════════════════════════════════════════════════════════════════
// Journey 2 — a draft Spec appears in the tag-filtered listing (ac-6)
// ══════════════════════════════════════════════════════════════════════════════

test(T2, async ({ page, resources }) => {
  const slug = resources.slug("j67b");
  const tenant = await seedOrgTenant({ slug });

  // The reported failure was "what Specs tagged `testbash` mention login?" returning
  // nothing, because the listing dropped every DRAFT Spec. seedSpec creates at draft,
  // which is exactly the case that used to vanish.
  const draft = await seedSpec({
    memexId: tenant.memexId,
    title: "Login flow draft",
    purpose: "A draft Spec that must be findable by tag.",
  });
  await seedTags({ memexId: tenant.memexId, docId: draft.docId, tags: ["testbash"] });

  const untagged = await seedSpec({
    memexId: tenant.memexId,
    title: "Unrelated draft",
    purpose: "Carries no tag.",
  });
  void untagged;

  const boardUrl = tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs");
  await page.goto(boardUrl);
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });

  // Both drafts visible unfiltered.
  await expect(page.getByText("Login flow draft")).toBeVisible();
  await expect(page.getByText("Unrelated draft")).toBeVisible();

  // Filter to the tag — the draft Spec must survive the filter, not be dropped by it.
  await page.getByTestId("tag-filter-toggle").click();
  await page
    .getByTestId("tag-filter-option")
    .filter({ hasText: "testbash" })
    .click();
  await page.keyboard.press("Escape");

  await expect(page.getByText("Login flow draft")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Unrelated draft")).toBeHidden();
});

// ══════════════════════════════════════════════════════════════════════════════
// Journey 3 — supersession banner + mirror, display-only (ac-14)
// ══════════════════════════════════════════════════════════════════════════════

test(T3, async ({ page, resources }) => {
  const slug = resources.slug("j67c");
  const tenant = await seedOrgTenant({ slug });

  const predecessor = await seedSpec({
    memexId: tenant.memexId,
    title: "Channel-aware footer projection",
    purpose: "History worth keeping, prose no longer true.",
  });
  const successor = await seedSpec({
    memexId: tenant.memexId,
    title: "Unified footer projection",
    purpose: "The Spec that carries current intent.",
  });

  // Seeded rather than clicked, BECAUSE the web has no control for it — dec-4 makes
  // supersession MCP-only, and the absence of a button is itself part of ac-14. The
  // seed runs the real supersedeSpec service, so every guard and the bus emit are live.
  await seedSupersede({
    memexId: tenant.memexId,
    docId: predecessor.docId,
    supersededByDocId: successor.docId,
    note: "absorbed into the unified projection",
  });

  // ── The PREDECESSOR opens with the banner, linking to its successor. ────────
  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${predecessor.handle}`),
  );
  const banner = page.getByTestId("superseded-by-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(/Superseded by/);
  await expect(banner).toContainText("absorbed into the unified projection");
  // role="status" so the state is announced, and legible without colour.
  await expect(banner).toHaveAttribute("role", "status");

  // Its content is STILL SERVED — the contrast with archive, which withholds.
  await expect(
    page.getByText("History worth keeping, prose no longer true."),
  ).toBeVisible();

  // ac-14: display-only. No control anywhere on this page sets or clears supersession.
  await expect(page.getByRole("button", { name: /supersede/i })).toHaveCount(0);
  await expect(page.getByText(/mark .*superseded/i)).toHaveCount(0);

  // ── The link goes to the successor, which carries the MIRROR. ───────────────
  await banner.getByRole("link", { name: successor.handle }).click();
  await expect(page.getByTestId("replaces-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("replaces-banner")).toContainText(
    `Replaces ${predecessor.handle}`,
  );
  // The successor is not itself marked superseded.
  await expect(page.getByTestId("superseded-by-banner")).toHaveCount(0);
});
