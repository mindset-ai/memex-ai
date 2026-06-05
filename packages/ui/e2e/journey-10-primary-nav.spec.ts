import { test, expect, bareUrl } from "./helpers/index.js";

// Journey 10 — primary navigation (re-based onto the post-0038 product, spec-172 t-5).
//
// The header's primary nav (AppShell.tsx, data-testid="primary-nav") exposes the
// always-present entry points — Specs, Issues, Standards — plus feature-gated
// extras (Pulse / Insights / Scaffold) that may be hidden per session. Each link
// routes the user, PATH-BASED [per std-2], to the matching list page under the
// active tenant (`/<ns>/<mx>/...`), and the page renders its title as an <h1>
// (PageHeader). We assert the always-present three are present and route.

test("primary nav routes to the always-present list pages", async ({ page }) => {
  await page.goto(bareUrl("/"));

  // Bare-domain landing auto-resolves to the dev user's personal-memex Specs
  // board. Wait for the Specs heading before clicking around.
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
    timeout: 15_000,
  });

  const nav = page.getByTestId("primary-nav");
  await expect(nav).toBeVisible();

  // The three always-present nav links are rendered + clickable.
  await expect(nav.getByRole("link", { name: "Specs" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Issues" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Standards" })).toBeVisible();

  // Issues — path-based `/<ns>/<mx>/issues`.
  await nav.getByRole("link", { name: "Issues" }).click();
  await expect(page).toHaveURL(/\/issues(\?|#|$)/);
  await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();

  // Standards — path-based `/<ns>/<mx>/standards`.
  await nav.getByRole("link", { name: "Standards" }).click();
  await expect(page).toHaveURL(/\/standards(\?|#|$)/);
  await expect(page.getByRole("heading", { name: "Standards" })).toBeVisible();

  // Back to Specs.
  await nav.getByRole("link", { name: "Specs" }).click();
  await expect(page).toHaveURL(/\/specs(\?|#|$)/);
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible();
});

test("primary nav is hidden when viewing a single Spec", async ({
  page,
  resources,
}) => {
  // Seed a Spec into the dev user's personal memex so there is a doc to open.
  const { getPersonalMemexByEmail, seedSpecInMemex, DEV_EMAIL } = await import(
    "./helpers/index.js"
  );
  const memex = await getPersonalMemexByEmail(DEV_EMAIL);
  expect(memex).not.toBeNull();
  const { docId, handle } = await seedSpecInMemex({
    memexId: memex!.memexId,
    title: `Nav probe ${resources.uniq}`,
  });
  resources.docIds.push(docId);

  await page.goto(bareUrl("/"));
  await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
    timeout: 15_000,
  });

  // Open the seeded Spec via its canonical path. The primary nav hides on a
  // single-doc view; the "All specs" back link replaces it.
  const { tenantPath } = await import("./helpers/index.js");
  await page.goto(
    tenantPath(memex!.namespaceSlug, memex!.memexSlug, `/specs/${handle}`)
  );
  await expect(page.getByTestId("primary-nav")).not.toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("link", { name: /All specs/i })).toBeVisible();
});
