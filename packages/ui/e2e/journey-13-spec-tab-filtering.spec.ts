import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedDoc } from "./helpers/retained.js";

// Journey 13: Top-level Specs / Standards nav filtering. Confirms the list pages
// are docType-scoped — no standard docs leak into Specs, no spec docs leak into
// Standards.
//
// Re-based off the account-era harness (dec-2): HTTP-only seeding, path-based
// navigation [per std-2].
//
// NOTE (re-base): the original drove the legacy `/missions` alias to assert it
// still routes to the Specs list. That alias is GONE post-0038 — only
// `/briefs` → `/specs` survives in services/redirects.ts (rewriteBriefPathToSpec);
// `/missions` and `/strategies` are no longer routed client- or server-side. This
// journey navigates the canonical `/specs` instead; the retired `/missions` alias
// is surfaced as a blocker, not silently restored.

test("primary nav scopes the list page to the right docType", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j13");
  const tenant = await seedOrgTenant({ slug });

  // Seed one of each docType so each list page has something to render.
  await seedSpec({ memexId: tenant.memexId, title: "Spec A", purpose: "Spec purpose." });
  await seedDoc({
    memexId: tenant.memexId,
    title: "Standard A",
    body: "Standard purpose.",
    docType: "standard",
  });
  await seedDoc({
    memexId: tenant.memexId,
    title: "Document A",
    body: "Document purpose.",
    docType: "document",
  });

  // Specs page: only Spec A.
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
  await expect(page.getByText("Spec A")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Standard A")).not.toBeVisible();
  await expect(page.getByText("Document A")).not.toBeVisible();

  // Standards page: only Standard A.
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/standards"));
  await expect(page.getByText("Standard A")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Spec A")).not.toBeVisible();
  await expect(page.getByText("Document A")).not.toBeVisible();
});
