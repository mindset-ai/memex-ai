import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedTags } from "./helpers/retained.js";
import { installAcEmission } from "./helpers/emit-ac.js";

// spec-418 t-7 — the PR-gate e2e journey for the tag-admin / curation surface
// (std-28). Drives the REAL UI end-to-end against a freshly-seeded, isolated
// tenant: from the Specs board, open the TagFilter dropdown → "Manage tags" →
// land on /:ns/:mx/specs/tags, then walk the three curation mutations through the
// real dialogs and the real REST routes (POST /tags, PATCH /tags/:id, DELETE
// /tags/:id). No raw SQL, no faked server — seeding goes through the env-gated
// /api/__test__ surface (applyTagStrings), which emits on the bus like a real
// write, and every mutation runs the actual tags service.
//
// AC coverage (tagged in the afterEach installed below):
//   ac-25 — a member can CREATE a tag directly from the manage-tags surface
//           without first attaching it to a Spec (it appears at 0 Specs).
//   ac-2  — a member can RENAME a tag; the new name is reflected on every Spec
//           that carried it (proven on the board cards, not just the catalogue).
//   ac-3  — a rename that would DUPLICATE an existing tag is refused with a plain
//           reason and makes no change.
//   ac-4  — a member can DELETE a tag; it is removed from every carrying Spec and
//           those Specs are otherwise untouched.

const SPEC = "mindset-prod/memex-building-itself/specs/spec-418";
const AC_RENAME = `${SPEC}/acs/ac-2`;
const AC_DUP_REFUSED = `${SPEC}/acs/ac-3`;
const AC_DELETE = `${SPEC}/acs/ac-4`;
const AC_CREATE = `${SPEC}/acs/ac-25`;

const TITLE =
  "a member creates, renames (and is blocked on a duplicate), and deletes tags across the carrying Specs";

installAcEmission(test, import.meta.url, {
  [TITLE]: [AC_CREATE, AC_RENAME, AC_DUP_REFUSED, AC_DELETE],
});

test(TITLE, async ({ page, resources }) => {
  // ── Seed: a tenant + two Specs sharing a flat tag, plus a second distinct tag
  // (the collision target for the duplicate-rename block). Flat tags only, so no
  // per-scope exclusivity concerns muddy the rename/duplicate assertions.
  const slug = resources.slug("j56");
  const tenant = await seedOrgTenant({ slug });

  const alpha = await seedSpec({
    memexId: tenant.memexId,
    title: "Curation Alpha",
    purpose: "Alpha spec.",
  });
  const beta = await seedSpec({
    memexId: tenant.memexId,
    title: "Curation Beta",
    purpose: "Beta spec.",
  });
  // "shared" rides both Specs (2 Specs); "keeper" rides only Alpha (1 Spec).
  await seedTags({ memexId: tenant.memexId, docId: alpha.docId, tags: ["shared", "keeper"] });
  await seedTags({ memexId: tenant.memexId, docId: beta.docId, tags: ["shared"] });

  const boardUrl = tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs");

  // Locators reused across the journey. Match on the tag VALUE exactly (not a
  // loose subtree substring) — the row's Rename/Delete controls carry the value in
  // their accessible name, so `filter({ hasText })` matched every row; scope the
  // filter to an exact-text `tag-chip-value` so each helper resolves one row/chip.
  const cardTagChips = (name: string) =>
    page
      .getByTestId("spec-card-tags")
      .getByTestId("tag-chip")
      .filter({ has: page.getByTestId("tag-chip-value").getByText(name, { exact: true }) });
  const tagRow = (name: string) =>
    page
      .getByTestId("tag-row")
      .filter({ has: page.getByTestId("tag-chip-value").getByText(name, { exact: true }) });

  // ── 1) Open the board; the shared tag renders on both Spec cards. ──────────
  await page.goto(boardUrl);
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Curation Alpha")).toBeVisible();
  await expect(page.getByText("Curation Beta")).toBeVisible();
  await expect(cardTagChips("shared")).toHaveCount(2);

  // ── 2) Enter the surface via the SINGLE affordance: TagFilter → "Manage tags".
  await page.getByTestId("tag-filter-toggle").click();
  await expect(page.getByTestId("tag-filter-dropdown")).toBeVisible();
  await page.getByTestId("tag-filter-manage").click();
  await page.waitForURL(/\/specs\/tags(\?|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("manage-tags-new")).toBeVisible({ timeout: 15_000 });
  // Baseline catalogue: shared (2), keeper (1).
  await expect(tagRow("shared").getByTestId("tag-count")).toHaveText("2");
  await expect(tagRow("keeper").getByTestId("tag-count")).toHaveText("1");

  // ── 3) CREATE a brand-new tag → appears at 0 Specs (ac-25). ────────────────
  await page.getByTestId("manage-tags-new").click();
  const createDialog = page.getByTestId("tag-create-dialog");
  await expect(createDialog).toBeVisible();
  await createDialog.getByTestId("tag-dialog-input").fill("fresh");
  await createDialog.getByTestId("tag-dialog-confirm").click();
  await expect(createDialog).toBeHidden();
  // The new tag is attached to no Spec — it starts at 0.
  await expect(tagRow("fresh").getByTestId("tag-count")).toHaveText("0");

  // ── 4a) RENAME the shared tag; every carrying Spec follows the new name (ac-2).
  await tagRow("shared").getByTestId("tag-rename").click();
  const renameDialog = page.getByTestId("tag-rename-dialog");
  await expect(renameDialog).toBeVisible();
  await renameDialog.getByTestId("tag-dialog-input").fill("renamed");
  await renameDialog.getByTestId("tag-dialog-confirm").click();
  await expect(renameDialog).toBeHidden();
  // Catalogue reflects the rename, count preserved (still 2 Specs).
  await expect(tagRow("renamed").getByTestId("tag-count")).toHaveText("2");
  await expect(tagRow("shared")).toHaveCount(0);

  // The rename is reflected on EVERY Spec that carried it — proven on the board.
  await page.goto(boardUrl);
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect(cardTagChips("renamed")).toHaveCount(2);
  await expect(cardTagChips("shared")).toHaveCount(0);
  // Alpha's other tag is untouched.
  await expect(cardTagChips("keeper")).toHaveCount(1);

  // ── 4b) A rename that DUPLICATES an existing tag is refused, no change (ac-3).
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs/tags"));
  await expect(page.getByTestId("manage-tags-new")).toBeVisible({ timeout: 15_000 });
  await tagRow("renamed").getByTestId("tag-rename").click();
  const dupDialog = page.getByTestId("tag-rename-dialog");
  await expect(dupDialog).toBeVisible();
  await dupDialog.getByTestId("tag-dialog-input").fill("keeper");
  // Plain-reason block, and the confirm is disabled — the rename can't proceed.
  await expect(dupDialog.getByTestId("tag-dialog-block")).toHaveText(/already exists/i);
  await expect(dupDialog.getByTestId("tag-dialog-confirm")).toBeDisabled();
  await dupDialog.getByTestId("tag-dialog-cancel").click();
  await expect(dupDialog).toBeHidden();
  // No change: "renamed" still at 2, "keeper" still at 1.
  await expect(tagRow("renamed").getByTestId("tag-count")).toHaveText("2");
  await expect(tagRow("keeper").getByTestId("tag-count")).toHaveText("1");

  // ── 5) DELETE a tag; removed from every carrying Spec, Specs intact (ac-4). ─
  await tagRow("renamed").getByTestId("tag-delete").click();
  const deleteDialog = page.getByTestId("tag-delete-dialog");
  await expect(deleteDialog).toBeVisible();
  // The confirm states the blast radius (2 Specs) before the action.
  await expect(deleteDialog.getByTestId("tag-delete-blast")).toContainText("2 Spec");
  await deleteDialog.getByTestId("tag-dialog-confirm").click();
  await expect(deleteDialog).toBeHidden();
  // Named post-delete confirmation, and the catalogue row is gone.
  await expect(page.getByTestId("manage-tags-toast")).toContainText("renamed");
  await expect(tagRow("renamed")).toHaveCount(0);

  // On the board, the deleted tag is gone from every Spec that carried it, but
  // the Specs themselves — and their other tags — are untouched.
  await page.goto(boardUrl);
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Curation Alpha")).toBeVisible();
  await expect(page.getByText("Curation Beta")).toBeVisible();
  await expect(cardTagChips("renamed")).toHaveCount(0);
  await expect(cardTagChips("keeper")).toHaveCount(1);
});
