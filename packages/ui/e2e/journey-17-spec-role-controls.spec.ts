import { test, expect, ensureUser, DEV_EMAIL, type TestResources } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  getDocRole,
  getAssigneeCount,
  type SeededOrgTenant,
} from "./helpers/retained.js";
import type { Page } from "@playwright/test";

// Journey 17 (spec-118): per-Spec role posture (editor/reviewer) + ticket-style
// assignment controls on the Spec header — SpecRoleControls.
//
// A Spec seeded through createDocDraft WITHOUT a createdByUserId has NO doc_members
// editor row, so dev@memex.ai opens it as a REVIEWER — the exact state in the bug
// report: "Reviewer · Switch to editing · Assignees Unassigned · Assign me · Assign
// someone", where clicking the affordances did nothing. These journeys exercise the
// affordances end-to-end against a live server so a regression where the controls
// render but are inert (no handler, disabled, or covered by an overlay) fails loudly.
//
// Re-based off the raw-SQL db-memex.ts harness (dec-2): the org tenant + Spec are
// seeded through the test-only HTTP surface (real services → bus emissions
// [per std-8]); role/assignee reads go through the same surface; navigation is
// path-based [per std-2].

interface RoleSeed {
  tenant: SeededOrgTenant;
  docId: string;
  devId: string;
}

const test2 = test.extend<{ seed: RoleSeed }>({
  seed: async ({ resources }: { resources: TestResources }, use) => {
    const devId = await ensureUser(DEV_EMAIL);
    const slug = resources.slug("j17");
    const tenant = await seedOrgTenant({ slug });
    // No createdByUserId → no doc_members editor row → dev opens as REVIEWER.
    const { docId } = await seedSpec({ memexId: tenant.memexId, title: "Roles Spec" });
    await use({ tenant, docId, devId });
  },
});

async function gotoSpec(page: Page, seed: RoleSeed) {
  await page.goto(
    `${process.env.E2E_BASE_URL ?? "http://localhost:5173"}/${seed.tenant.namespaceSlug}/${seed.tenant.memexSlug}/docs/${seed.docId}`,
  );
  await expect(page.getByRole("heading", { name: "Roles Spec", level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("spec-role-controls")).toBeVisible();
}

test2.describe("Spec role controls (spec-118)", () => {
  test2("controls are interactive — buttons enabled and not covered by an overlay", async ({
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

  test2('"Assign someone" opens the people picker (pure client state)', async ({ page, seed }) => {
    await gotoSpec(page, seed);

    const picker = page.getByTestId("spec-assign-picker");
    await expect(picker.getByRole("listbox")).toHaveCount(0);
    await picker.getByRole("button", { name: "Assign someone" }).click();
    await expect(picker.getByRole("listbox")).toBeVisible();
  });

  test2('"Switch to editing" promotes the viewer to editor and flips the posture', async ({
    page,
    seed,
  }) => {
    await gotoSpec(page, seed);

    const controls = page.getByTestId("spec-role-controls");
    await expect(page.getByTestId("spec-role-badge")).toHaveText("Reviewer");

    await controls.getByRole("button", { name: "Switch to editing" }).click();

    await expect(page.getByTestId("spec-role-badge")).toHaveText("Editor");
    await expect(controls.getByRole("button", { name: "Switch to reviewing" })).toBeVisible();

    // Server-backed: a doc_members editor row now exists for the dev user.
    expect(await getDocRole(seed.tenant.memexId, seed.docId, seed.devId)).toBe("editor");

    // Persists across reload.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Roles Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("spec-role-badge")).toHaveText("Editor");
  });

  test2('"Assign me" adds the viewer as an assignee', async ({ page, seed }) => {
    await gotoSpec(page, seed);

    const controls = page.getByTestId("spec-assign-control");
    await expect(controls.getByText("Unassigned")).toBeVisible();

    await controls.getByRole("button", { name: "Assign me" }).click();

    await expect(controls.getByText("Unassigned")).toHaveCount(0);
    await expect(controls.getByText(/Dev User|dev@memex\.ai/)).toBeVisible();
    expect(await getAssigneeCount(seed.tenant.memexId, seed.docId)).toBe(1);
  });
});
