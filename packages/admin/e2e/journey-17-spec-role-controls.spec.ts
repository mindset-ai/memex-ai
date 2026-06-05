import { test as base, expect, type Page } from "@playwright/test";
import {
  ensureDevUser,
  seedMemexWithSpec,
  dbDocRole,
  dbAssigneeCount,
  dropNamespace,
  type SeededMemexDoc,
} from "./helpers/db-memex.js";

// Journey 17 (spec-118): per-Spec role posture (editor/reviewer) + ticket-style
// assignment controls on the Spec header — SpecRoleControls.
//
// A Spec seeded directly in the DB has NO doc_members editor row, so dev@memex.ai
// opens it as a REVIEWER — the exact state in the bug report: "Reviewer · Switch
// to editing · Assignees Unassigned · Assign me · Assign someone", where clicking
// the affordances did nothing. These journeys exercise the affordances end-to-end
// against a live server so a regression where the controls render but are inert
// (no handler, disabled, or covered by an overlay) fails loudly.
//
// Uses the current tenancy schema (db-memex.ts) and path-based routing
// (/<namespace>/<memex>/docs/:id), not the legacy accounts/subdomain harness.

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";

// Per-test seed + cleanup on the current schema.
const test = base.extend<{ seed: SeededMemexDoc; devId: string }>({
  devId: async ({}, use) => {
    use(await ensureDevUser());
  },
  seed: async ({}, use, testInfo) => {
    const slug = `j17-${testInfo.title.replace(/[^a-z0-9]+/gi, "").slice(0, 8).toLowerCase()}-${Date.now().toString(36)}`;
    const seeded = await seedMemexWithSpec({ slug, title: "Roles Spec" });
    await use(seeded);
    await dropNamespace(seeded.namespaceId);
  },
});

async function gotoSpec(page: Page, seed: SeededMemexDoc) {
  await page.goto(`${BASE}/${seed.namespaceSlug}/${seed.memexSlug}/docs/${seed.docId}`);
  await expect(page.getByRole("heading", { name: "Roles Spec", level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("spec-role-controls")).toBeVisible();
}

test.describe("Spec role controls (spec-118)", () => {
  test("controls are interactive — buttons enabled and not covered by an overlay", async ({
    page,
    seed,
  }) => {
    await gotoSpec(page, seed);

    const controls = page.getByTestId("spec-role-controls");
    const switchBtn = controls.getByRole("button", { name: "Switch to editing" });
    const assignSomeone = controls.getByRole("button", { name: "Assign someone" });

    await expect(switchBtn).toBeVisible();
    await expect(switchBtn).toBeEnabled();
    await expect(assignSomeone).toBeEnabled();

    // Nothing is sitting on top of the button — the element at the button's
    // centre IS the button (or a descendant), not an overlay swallowing clicks.
    const hitIsButton = await switchBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el === top || el.contains(top) || (top != null && top.contains(el));
    });
    expect(hitIsButton, "an overlay is intercepting clicks on the posture button").toBe(true);
  });

  test('"Assign someone" opens the people picker (pure client state)', async ({ page, seed }) => {
    await gotoSpec(page, seed);

    const picker = page.getByTestId("spec-assign-picker");
    await expect(picker.getByRole("listbox")).toHaveCount(0);
    await picker.getByRole("button", { name: "Assign someone" }).click();
    await expect(picker.getByRole("listbox")).toBeVisible();
  });

  test('"Switch to editing" promotes the viewer to editor and flips the posture', async ({
    page,
    seed,
    devId,
  }) => {
    await gotoSpec(page, seed);

    const controls = page.getByTestId("spec-role-controls");
    await expect(page.getByTestId("spec-role-badge")).toHaveText("Reviewer");

    await controls.getByRole("button", { name: "Switch to editing" }).click();

    await expect(page.getByTestId("spec-role-badge")).toHaveText("Editor");
    await expect(controls.getByRole("button", { name: "Switch to reviewing" })).toBeVisible();

    // Server-backed: a doc_members editor row now exists for the dev user.
    expect(await dbDocRole(seed.docId, devId)).toBe("editor");

    // Persists across reload.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Roles Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("spec-role-badge")).toHaveText("Editor");
  });

  test('"Assign me" adds the viewer as an assignee', async ({ page, seed }) => {
    await gotoSpec(page, seed);

    const controls = page.getByTestId("spec-assign-control");
    await expect(controls.getByText("Unassigned")).toBeVisible();

    await controls.getByRole("button", { name: "Assign me" }).click();

    await expect(controls.getByText("Unassigned")).toHaveCount(0);
    await expect(controls.getByText(/Dev User|dev@memex\.ai/)).toBeVisible();
    expect(await dbAssigneeCount(seed.docId)).toBe(1);
  });
});
