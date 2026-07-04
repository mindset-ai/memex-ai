// Journey 56 — spec-448: document versioning (create → view-as-of → compare →
// restore) plus the catch-up-on-reopen dialog (std-28 PR-gate journey).
//
// Journey A drives the full versioning lifecycle through the real UI: cut a
// version from the ⋯ menu (pruning Tasks, dec-2's leave-behind mechanic),
// confirm the header badge, view the frozen cut as-of, compare it against the
// live primary (asserting the section diff actually paints highlights, not
// just an "unchanged" pass-through), then restore back to it and confirm the
// restore's own provenance label.
//
// Journey B exercises the catch-up dialog: a version cut made OUT OF BAND
// (via the seed-version-cut test-only endpoint, t-12 — see its header comment
// in routes/__test__.ts for why this can't be driven through the browser)
// puts the doc ahead of the viewer's last-seen marker; reopening surfaces the
// "you've fallen behind" dialog, "Show me what changed" opens the
// pre-anchored diff, and a subsequent reopen (now caught up) shows no dialog
// — alongside the necessarily-first reopen (a first-time viewer), which also
// shows none.
//
// Seeding is HTTP-only over the __test__ surface (spec-172 dec-2, std-28):
// seed-org, seed-spec, seed-task, seed-version-cut. Navigation is path-based
// [per std-2]. Selectors are cross-checked against the real component source:
// CreateVersionDialog.tsx, VersionSwitcher.tsx, DiffOverlay.tsx,
// CatchUpDialog.tsx, SpecMenu.tsx, DocDocument.tsx, utils/diffHighlight.ts.

import {
  test,
  expect,
  tenantPath,
  ensureUser,
  seedTask,
  seedVersionCut,
  installAcEmission,
  type TestResources,
} from "./helpers/index.js";
import { seedOrgTenant, seedSpec, tenantApiUrl } from "./helpers/retained.js";
import type { Page, Locator } from "@playwright/test";

const SPEC448 = "mindset-prod/memex-building-itself/specs/spec-448";
const AC = (n: number) => `${SPEC448}/acs/ac-${n}`;

installAcEmission(test, import.meta.url, {
  "cut a version, view it as-of, compare it, and restore it": [
    AC(1),
    AC(3),
    AC(4),
    AC(5),
    AC(27),
  ],
  "catch-up dialog: a behind viewer sees it; first-time and already-current viewers don't": [
    AC(9),
    AC(40),
    AC(42),
  ],
});

async function gotoSpec(
  page: Page,
  ns: string,
  mx: string,
  handle: string,
  title: string,
): Promise<void> {
  await page.goto(tenantPath(ns, mx, `/specs/${handle}`));
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Deterministically open the version-history panel (VersionSwitcher.tsx),
 * closing it first via Escape if a prior step left it open. The panel's own
 * trigger is a toggle (`setOpen((v) => !v)`), so re-clicking it without first
 * checking visibility would close an already-open panel instead of opening
 * a fresh one.
 */
async function openHistoryPanel(page: Page): Promise<Locator> {
  const panel = page.getByTestId("version-switcher-panel");
  if (await panel.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  }
  await page.getByTestId("version-switcher-trigger").click();
  await expect(panel).toBeVisible();
  return panel;
}

interface VersionSnapshotProbe {
  snapshot: { tasks: Array<{ title: string }> };
}

/** Mirrors registerDiffHighlights' own cast (utils/diffHighlight.ts) — the
 *  CSS Custom Highlight API registers Ranges under well-known names with NO
 *  DOM mutation (ac-31), so the highlight registry itself is the only way to
 *  assert a block/word highlight actually rendered. */
type HighlightRegistry = { highlights?: Map<string, { size: number }> };

async function highlightSize(page: Page, name: string): Promise<number> {
  return page.evaluate((highlightName) => {
    const cssAny = (globalThis as unknown as { CSS: HighlightRegistry }).CSS;
    return cssAny.highlights?.get(highlightName)?.size ?? 0;
  }, name);
}

test.describe("spec-448 — document versioning", () => {
  test("cut a version, view it as-of, compare it, and restore it", async ({
    page,
    resources,
  }: {
    page: Page;
    resources: TestResources;
  }) => {
    const tenant = await seedOrgTenant({ slug: resources.slug("j56a") });
    const title = `Versioning journey ${resources.uniq}`;
    const { docId, handle, sectionId } = await seedSpec({
      memexId: tenant.memexId,
      title,
      purpose: "Original purpose text for the versioning journey.",
    });
    const taskTitle = `Draft the migration plan ${resources.uniq}`;
    await seedTask({ memexId: tenant.memexId, docId, title: taskTitle });

    await gotoSpec(page, tenant.namespaceSlug, tenant.memexSlug, handle, title);

    // ac-3: purely additive — no badge before the doc has ever been cut
    // (DocDocument gates the badge on `doc.version >= 2`).
    await expect(page.getByTestId("version-badge")).toHaveCount(0);

    // ⋯ menu → "Create new version" (SpecMenu.tsx: the trigger's aria-label is
    // literally `Actions for ${doc.title}`; menu items are role=menuitem).
    await page.getByRole("button", { name: `Actions for ${title}` }).click();
    await page.getByRole("menuitem", { name: "Create new version" }).click();

    // CreateVersionDialog.tsx: a required "Version name" input (label `for`
    // wired to #create-version-name) plus five carry-forward checkboxes in
    // CARRY_FORWARD_CLASSES order (decisions, acs, tasks, issues, comments —
    // services/versioning.ts), all checked by default. Select Tasks by text —
    // NOT by index: the "Version name" <label> is itself the form's first
    // <label>, which makes any nth() index off-by-one.
    await page.getByLabel("Version name").fill("Reviewed cut");
    const createDialog = page.locator("#create-version-name").locator("xpath=ancestor::form");
    // Exact-text match on the option title — a loose `hasText: "Tasks"` also
    // matches the Comments option, whose description ends "…and tasks".
    const tasksLabel = createDialog
      .locator('label:has(input[type="checkbox"])')
      .filter({ has: page.getByText("Tasks", { exact: true }) });
    await expect(tasksLabel).toContainText("Tasks");
    await tasksLabel.locator('input[type="checkbox"]').uncheck();
    await createDialog.getByRole("button", { name: "Create version" }).click();

    // ac-1/ac-2: the badge appears once the doc reloads at version 2.
    const badge = page.getByTestId("version-badge");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toContainText("V2");

    // An out-of-band edit AFTER the cut, so V1's frozen section content
    // diverges from the live (now-v2) primary — otherwise comparing V1 ⇄
    // current would show every section "unchanged" and there would be
    // nothing for the diff highlighter to paint. Uses the real production
    // section-update route (routes/documents.ts POST /docs/sections/:id — the
    // same uniform write path the doc-16 reactivity journeys already use),
    // via page.request so it rides the browser's own (dev-mode) session.
    await page.request.post(
      tenantApiUrl(tenant.namespaceSlug, tenant.memexSlug, `docs/sections/${sectionId}`),
      { data: { content: "Updated purpose text after the first cut, for the diff to highlight." } },
    );

    // ac-4/ac-5/ac-26: open the version-history switcher.
    await openHistoryPanel(page);
    const v1Row = page.locator('[data-testid="version-row"][data-version="1"]');
    await expect(v1Row).toContainText("Reviewed cut");
    await expect(page.getByTestId("version-row-primary")).toContainText("V2");

    // View V1 as-of: the frozen snapshot shows the ORIGINAL section content,
    // never the edit made after the cut (ac-4/ac-18/ac-25).
    await v1Row.getByRole("button", { name: "View" }).click();
    const viewOverlay = page.getByTestId("version-view-overlay");
    await expect(viewOverlay).toBeVisible();
    await expect(viewOverlay).toContainText("Viewing V1");
    await expect(viewOverlay).toContainText("Original purpose text for the versioning journey.");
    await expect(viewOverlay).not.toContainText("Updated purpose text");
    await page.getByRole("button", { name: "Close version view" }).click();
    await expect(viewOverlay).toHaveCount(0);

    // dec-2/ac-17/ac-19: the unchecked Tasks class was retired at the cut —
    // absent from the LIVE "Agent Tasks & Issues" sub-tab...
    await page.getByRole("button", { name: /^Agent Tasks & Issues\b/ }).click();
    await expect(page.getByTestId("task-card")).toHaveCount(0);

    // ...but still present in V1's own frozen snapshot. The view-as-of
    // overlay only renders section markdown (no task list), so the task
    // graph itself is asserted straight off the real versions GET route
    // (routes/versions.ts — the same one the UI's getVersionAsOf calls).
    const v1SnapshotRes = await page.request.get(
      tenantApiUrl(tenant.namespaceSlug, tenant.memexSlug, `versions/doc/${docId}/1`),
    );
    const v1Snapshot = (await v1SnapshotRes.json()) as VersionSnapshotProbe;
    expect(v1Snapshot.snapshot.tasks.some((t) => t.title === taskTitle)).toBe(true);

    // ac-26/ac-27: compare V1 ⇄ the live primary ("Current").
    const comparePanel = await openHistoryPanel(page);
    await comparePanel.getByTestId("compare-from-select").selectOption("1");
    await comparePanel.getByTestId("compare-to-select").selectOption("primary");
    await comparePanel.getByRole("button", { name: "Compare" }).click();

    const diffOverlay = page.getByTestId("diff-overlay");
    await expect(diffOverlay).toBeVisible();
    const changedSection = page.locator('[data-testid="diff-section"][data-status="changed"]');
    await expect(changedSection).toHaveCount(1);
    await expect(page.getByTestId("diff-body-old")).toContainText("Original purpose text");
    await expect(page.getByTestId("diff-body-new")).toContainText("Updated purpose text");

    // ac-7/ac-27/ac-30/ac-31: block AND word highlights registered via the
    // CSS Custom Highlight API — no DOM mutation, so the registry itself is
    // the only observable signal.
    await expect.poll(() => highlightSize(page, "diff-block")).toBeGreaterThan(0);
    const wordHighlights =
      (await highlightSize(page, "diff-add")) + (await highlightSize(page, "diff-del"));
    expect(wordHighlights).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Close diff" }).click();
    await expect(diffOverlay).toHaveCount(0);

    // ac-20/ac-21/ac-22/ac-23: restore V1. The auto-freeze checkpoint before
    // materialising V1's content means the restore's OWN document_versions
    // row lands as V3 (v1 = "Reviewed cut", v2 = the auto-freeze checkpoint,
    // v3 = "Restored from v1"); the live doc.version advances to 4.
    const restorePanel = await openHistoryPanel(page);
    await restorePanel
      .locator('[data-testid="version-row"][data-version="1"]')
      .getByRole("button", { name: "Restore" })
      .click();
    const confirm = page.getByTestId("restore-confirm");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Restore" }).click();
    await expect(confirm).toHaveCount(0);

    await expect(badge).toContainText("V4", { timeout: 15_000 });
    const finalPanel = await openHistoryPanel(page);
    const v3Row = finalPanel.locator('[data-testid="version-row"][data-version="3"]');
    await expect(v3Row).toContainText("restored from V1");
  });
});

test.describe("spec-448 — catch-up on reopen", () => {
  test("catch-up dialog: a behind viewer sees it; first-time and already-current viewers don't", async ({
    page,
    resources,
  }: {
    page: Page;
    resources: TestResources;
  }) => {
    const tenant = await seedOrgTenant({ slug: resources.slug("j56b") });
    const title = `Catch-up journey ${resources.uniq}`;
    const { docId, handle } = await seedSpec({ memexId: tenant.memexId, title });
    const reviewerEmail = resources.email("j56-reviewer");
    const reviewerId = await ensureUser(reviewerEmail);

    // The doc reaches v2 BEFORE dev ever opens it — "a user views the Spec at
    // V2" starts from a doc that's already been cut once.
    await seedVersionCut({ memexId: tenant.memexId, docId, name: "First cut" });

    // ac-40: a FIRST-TIME viewer (no doc_views row yet) gets no dialog, even
    // though the doc has already been cut once — computeCatchUp (docViews.ts)
    // treats "never viewed" as NOT behind.
    await gotoSpec(page, tenant.namespaceSlug, tenant.memexSlug, handle, title);
    await expect(page.getByTestId("catch-up-dialog")).toHaveCount(0);

    // "Another actor" cuts V3 then V4 OUT OF BAND (seed-version-cut, t-12) —
    // dev's marker (just stamped at v2 by the GET above) is untouched, because
    // cutVersion never writes doc_views (only GET /docs/:id does, t-5).
    await seedVersionCut({
      memexId: tenant.memexId,
      docId,
      name: "Second cut",
      actorUserId: reviewerId,
    });
    await seedVersionCut({
      memexId: tenant.memexId,
      docId,
      name: "Third cut",
      actorUserId: reviewerId,
    });

    // ac-9/ac-39: reopening now surfaces the catch-up dialog — dev is behind
    // (last saw v2, the doc is now v4).
    await page.reload();
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    const catchUp = page.getByTestId("catch-up-dialog");
    await expect(catchUp).toBeVisible();
    await expect(catchUp).toContainText("V2");
    await expect(catchUp).toContainText("V4");

    // ac-42: "Show me what changed" swaps straight to the pre-anchored diff
    // (fromVersion ⇄ the live primary) — reusing the same DiffOverlay the
    // version switcher's own compare action opens.
    await page.getByTestId("catch-up-show-changes").click();
    const diffOverlay = page.getByTestId("diff-overlay");
    await expect(diffOverlay).toBeVisible();
    await expect(diffOverlay).toContainText("Current");
    await page.getByRole("button", { name: "Close diff" }).click();
    await expect(catchUp).toHaveCount(0);

    // ac-41: the GET that rendered the dialog already advanced dev's marker
    // to current (routes/documents.ts stamps BEFORE computing catchUp for the
    // NEXT read) — an "already-current" reopen shows no dialog.
    await page.reload();
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("catch-up-dialog")).toHaveCount(0);
  });
});
