import { test, expect, ensureUser, tenantPath, DEV_EMAIL, emitAcEvents, type TestResources } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, type SeededOrgTenant } from "./helpers/retained.js";
import type { Page } from "@playwright/test";

// Journey 33 — spec-293: move a Spec between two Memexes.
//
// The end-to-end proof of the fix: dev owns two org Memexes; we seed a Spec in
// the first, open the redesigned Move dialog (dec-2/dec-3: whole-Spec move, no
// per-artifact checkboxes, "Comments" not "Section comments"), pick the second
// Memex, and confirm the Spec lands there at its new handle. All seeding goes
// through the env-gated test surface (real services → bus, std-8); navigation is
// path-based (std-2).

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-293/acs/ac-${n}`;

const ACS_BY_TITLE: Record<string, string[]> = {
  "the Move dialog moves the whole Spec to another Memex": [AC(1), AC(2), AC(13)],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TITLE[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-33-spec-293-move-spec.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

interface MoveSeed {
  source: SeededOrgTenant;
  target: SeededOrgTenant;
  docId: string;
  title: string;
}

const test2 = test.extend<{ seed: MoveSeed }>({
  seed: async ({ resources }: { resources: TestResources }, use) => {
    await ensureUser(DEV_EMAIL);
    // Two org Memexes the dev user owns → both are valid move destinations.
    const source = await seedOrgTenant({ slug: resources.slug("j33-src") });
    const target = await seedOrgTenant({ slug: resources.slug("j33-dst") });
    const title = `Movable Spec ${resources.slug("j33")}`;
    const { docId } = await seedSpec({ memexId: source.memexId, title });
    await use({ source, target, docId, title });
  },
});

async function gotoSpec(page: Page, seed: MoveSeed): Promise<void> {
  await page.goto(tenantPath(seed.source.namespaceSlug, seed.source.memexSlug, `/docs/${seed.docId}`));
  await expect(page.getByRole("heading", { name: seed.title, level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

test2.describe("spec-293 — Move spec between Memexes", () => {
  test2("the Move dialog moves the whole Spec to another Memex", async ({ page, seed }) => {
    await gotoSpec(page, seed);

    // Open the spec actions menu → Move.
    await page.getByRole("button", { name: `Actions for ${seed.title}` }).click();
    await page.getByRole("menuitem", { name: "Move to another memex" }).click();

    // The redesigned dialog (dec-2/dec-3): a read-only "what moves" summary,
    // no per-artifact opt-out checkboxes, and "Comments" — never "Section comments".
    // Scope every assertion to the dialog: the spec page behind it also has a
    // "Comments" tab, so page-wide text locators are ambiguous.
    const dialog = page.getByTestId("move-spec-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/What moves/i);
    await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(dialog).toContainText("Comments");
    await expect(dialog).not.toContainText(/Section comments/i);

    // Pick the target Memex and move.
    await dialog.getByRole("combobox").selectOption(seed.target.memexId);
    await dialog.getByRole("button", { name: /^Move$/ }).click();

    // We land on the moved Spec in the TARGET Memex, at its new handle.
    await page.waitForURL(
      new RegExp(`/${seed.target.namespaceSlug}/${seed.target.memexSlug}/specs/spec-\\d+`),
      { timeout: 20_000 },
    );
    await expect(page.getByRole("heading", { name: seed.title, level: 1 })).toBeVisible({
      timeout: 15_000,
    });
  });
});
