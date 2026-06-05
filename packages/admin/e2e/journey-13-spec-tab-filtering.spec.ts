import { test, expect, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, seedDoc } from "./helpers/db.js";

// Journey 13 (t-19 W5): Top-level Specs / Standards / Documents nav
// filtering (covers t-14). Confirms the nav links land on the right page and
// the lists are docType-scoped — no standard docs leak into Specs, no spec
// docs leak into Standards.

test("primary nav scopes the list page to the right docType", async ({
  page,
  resources,
}) => {
  const subdomain = resources.subdomain("j13");
  const accountId = await seedAccount({ subdomain, name: "Nav Filtering Test" });
  resources.accountIds.push(accountId);
  await resources.devAsAdmin(accountId);

  // Seed one of each docType so each list page has something to render.
  await seedDoc({
    accountId,
    handle: "doc-1",
    title: "Spec A",
    purpose: "Spec purpose.",
    docType: "spec",
  });
  await seedDoc({
    accountId,
    handle: "doc-2",
    title: "Standard A",
    purpose: "Standard purpose.",
    docType: "standard",
  });
  await seedDoc({
    accountId,
    handle: "doc-3",
    title: "Document A",
    purpose: "Document purpose.",
    docType: "document",
  });

  // Specs page: only Spec A. The legacy `/missions` and `/strategies` paths
  // remain as aliases (per t-3) — exercise `/missions` here so we know the
  // redirect/alias still routes to the Specs list.
  await page.goto(tenantUrl(subdomain, "/missions"));
  await expect(page.getByText("Spec A")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Standard A")).not.toBeVisible();
  await expect(page.getByText("Document A")).not.toBeVisible();

  // Standards page: only Standard A.
  await page.goto(tenantUrl(subdomain, "/standards"));
  await expect(page.getByText("Standard A")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Spec A")).not.toBeVisible();
  await expect(page.getByText("Document A")).not.toBeVisible();
});
