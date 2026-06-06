import { test, expect, ensureUser, DEV_EMAIL, type TestResources } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  getDocRole,
  getAssigneeCount,
  type SeededOrgTenant,
} from "./helpers/retained.js";
import type { Page } from "@playwright/test";

// Journey 17 — per-Spec posture (Editing/Reviewing) + assignment.
//
// RE-BASE NOTE (spec-172 t-5): the original journey drove `SpecRoleControls`
// (data-testid="spec-role-controls"), a header row removed in the spec-159
// redesign. Its two responsibilities were split into surviving surfaces, which
// this re-based journey exercises against the CURRENT UI:
//   • posture switch  → PostureDropdown header pill ("You are reviewing" →
//     menu "Editing"), promotes the viewer to editor (a doc_members editor row).
//   • assignment      → BylineAssignees ("+ Assign" pill → "Assign me"), on the
//     Spec byline (data-testid="byline-assignees" / "byline-assign-picker").
//
// A Spec seeded through createDocDraft WITHOUT a createdByUserId has NO doc_members
// editor row, so dev@memex.ai opens it as a REVIEWER. Seeding through the org
// tenant surface means dev is a writing org member, so the assignment affordances
// render. All seeding goes through the test-only HTTP surface (real services → bus
// emissions [per std-8]); navigation is path-based [per std-2].

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
    `${process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_UI_PORT ?? 5173}`}/${seed.tenant.namespaceSlug}/${seed.tenant.memexSlug}/docs/${seed.docId}`,
  );
  await expect(page.getByRole("heading", { name: "Roles Spec", level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

test2.describe("Spec posture + assignment (spec-159)", () => {
  test2("posture pill defaults to Reviewing and is interactive", async ({ page, seed }) => {
    await gotoSpec(page, seed);

    const pill = page.getByRole("button", { name: /You are reviewing/i });
    await expect(pill).toBeVisible();
    await expect(pill).toBeEnabled();

    // Opening the menu surfaces the two posture radios.
    await pill.click();
    await expect(page.getByRole("menuitemradio", { name: /Editing/i })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /Reviewing/i })).toBeVisible();
  });

  test2('"+ Assign" opens the people picker (lazy roster listbox)', async ({ page, seed }) => {
    await gotoSpec(page, seed);

    const picker = page.getByTestId("byline-assign-picker");
    await expect(picker.getByRole("listbox")).toHaveCount(0);
    await picker.getByRole("button", { name: "+ Assign" }).click();
    await expect(picker.getByRole("listbox")).toBeVisible();
  });

  test2("Editing promotes the viewer to editor and persists across reload", async ({
    page,
    seed,
  }) => {
    await gotoSpec(page, seed);

    await expect(page.getByRole("button", { name: /You are reviewing/i })).toBeVisible();

    await page.getByRole("button", { name: /You are reviewing/i }).click();
    await page.getByRole("menuitemradio", { name: /Editing/i }).click();

    await expect(page.getByRole("button", { name: /You are editing/i })).toBeVisible({
      timeout: 10_000,
    });

    // Server-backed: a doc_members editor row now exists for the dev user.
    await expect
      .poll(() => getDocRole(seed.tenant.memexId, seed.docId, seed.devId), {
        timeout: 10_000,
      })
      .toBe("editor");

    // Persists across reload.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Roles Spec", level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: /You are editing/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test2('"Assign me" adds the viewer as an assignee', async ({ page, seed }) => {
    await gotoSpec(page, seed);

    const picker = page.getByTestId("byline-assign-picker");
    await picker.getByRole("button", { name: "+ Assign" }).click();
    await picker.getByTestId("byline-assign-me").click();

    const byline = page.getByTestId("byline-assignees");
    await expect(byline.getByText(/Dev User|dev@memex\.ai/)).toBeVisible({
      timeout: 10_000,
    });
    await expect
      .poll(() => getAssigneeCount(seed.tenant.memexId, seed.docId), { timeout: 10_000 })
      .toBe(1);
  });
});
