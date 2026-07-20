import {
  test,
  expect,
  ensureUser,
  tenantPath,
  seedAssignee,
  emitAcEvents,
  DEV_EMAIL,
  type TestResources,
} from "./helpers/index.js";
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
  // tenantPath honours the E2E_BASE_URL / E2E_UI_PORT override chain — an inline
  // 5173 default here navigates to a foreign dev server on override-port runs.
  await page.goto(tenantPath(seed.tenant.namespaceSlug, seed.tenant.memexSlug, `/docs/${seed.docId}`));
  await expect(page.getByRole("heading", { name: "Roles Spec", level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

test2.describe("Spec posture + assignment (spec-159)", () => {
  test2("posture pill defaults to Reviewing and is interactive", async ({ page, seed }) => {
    await gotoSpec(page, seed);

    const pill = page.getByRole("button", { name: /You are reviewing/i });
    // 15s to match the suite convention — the pill renders after the doc's role
    // data loads, and the default 5s expect timeout flakes under full-suite load.
    await expect(pill).toBeVisible({ timeout: 15_000 });
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

const SPEC118 = "mindset-prod/memex-building-itself/specs/spec-118";

// ac-21: an assignment change propagates to open board views in REAL TIME via the
// spec-16 reactivity stream — no reload. The Specs board mounts
// useDocChangeStream(null, loadDocs) — a memex-wide /docs/events subscription — so
// a doc_assignee mutation made on ANOTHER channel refetches the board live. The
// sibling tests above cover the reload-persisted path (ac-15) and the assign
// gesture (ac-12); this closes the live-push half of ac-21 (previously untested).
// Emits ac-21 on pass AND fail per the ac-emission discipline.
test.describe("spec-118 ac-21 — assignment propagates to the board live", () => {
  test.afterEach(async ({}, testInfo) => {
    if (!testInfo.title.includes("ac-21")) return;
    await emitAcEvents(
      [`${SPEC118}/acs/ac-21`],
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/journey-17-spec-role-controls.spec.ts::${testInfo.title}`,
      testInfo.duration,
    );
  });

  test("an assignment made on another channel updates the open board live, no reload (ac-21)", async ({
    page,
    resources,
  }) => {
    const slug = resources.slug("j17-ac21");
    const tenant = await seedOrgTenant({ slug });
    const devUserId = await ensureUser(DEV_EMAIL);
    const spec = await seedSpec({
      memexId: tenant.memexId,
      title: "Live assignment spec",
      purpose: "Board should react to an assignment with no reload.",
    });

    // Arm the SSE-connection wait BEFORE navigating so we catch the board's
    // useDocChangeStream(null) opening GET /docs/events. The in-memory bus has no
    // replay: an assignment emitted before this subscriber attaches would be
    // dropped and the board would never react (cf. journey-16's grace windows).
    const boardStreamConnected = page.waitForResponse(
      (r) => r.url().includes("/docs/events") && r.status() === 200,
      { timeout: 15_000 },
    );

    // Board open — the card starts in the explicit "Unassigned" state.
    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
    await expect(page.getByText("Live assignment spec")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("spec-unassigned").first()).toBeVisible();

    // Wait until the stream's response headers are in, then a short settle so the
    // server-side bus.subscribe is registered before we emit — otherwise the
    // assignment event can race ahead of the subscription on a loaded CI box.
    await boardStreamConnected;
    await page.waitForTimeout(300);

    // Assign dev on a SEPARATE channel (test surface → real service → mutate() →
    // unified bus [per std-8]). The board's own React state is untouched, so any
    // update can ONLY arrive via SSE → useDocChangeStream → loadDocs.
    await seedAssignee({ memexId: tenant.memexId, docId: spec.docId, userId: devUserId });

    // The card flips to the assigned state live — the assignee cluster appears and
    // the "Unassigned" pill is gone — with NO page.reload().
    await expect(page.getByTestId("spec-assignees").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("spec-unassigned")).toHaveCount(0);
  });
});
