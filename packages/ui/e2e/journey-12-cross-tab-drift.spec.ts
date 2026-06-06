import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedDoc, seedOpenDecision } from "./helpers/retained.js";

// Journey 12 (t-19 W5): Cross-tab drift round-trip (covers t-18). Resolve a
// referenced decision in tab A; the drift dot should appear on the referencing
// standard in tab B without a manual refresh — proves the SSE drift event from
// services/decisions.ts::resolveDecision propagates into the StandardList page's
// useDocChangeStream subscription.
//
// Re-based off raw SQL (dec-2): the tenant + spec + open decision + standard are
// seeded through the test-only HTTP surface (real services → bus emissions
// [per std-8]); navigation is path-based [per std-2]; the decision is resolved
// through the flat /api/decisions/:id/resolve REST surface (UUID-keyed, std-5
// exemption), keeping the test focused on the SSE round-trip rather than the
// resolution dialog.

const API_URL = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;

test("resolving a decision in one tab lights the drift badge on a standard in another", async ({
  browser,
  resources,
}) => {
  const slug = resources.slug("j12");
  const tenant = await seedOrgTenant({ slug });

  // Seed a spec with one open decision, plus a standard whose section references
  // that decision via the conventional `[per dec-N]` form so scanForDecisionDrift's
  // FTS scan matches when the decision resolves.
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Spec with Decision",
    purpose: "Spec purpose.",
  });
  const { decisionId, seq: decSeq } = await seedOpenDecision({
    memexId: tenant.memexId,
    docId: spec.docId,
    title: "Pick database",
    context: "Two options considered.",
    options: [
      { label: "Postgres", trade_offs: "Familiar; SQL." },
      { label: "DynamoDB", trade_offs: "Scales; weaker queries." },
    ],
  });
  await seedDoc({
    memexId: tenant.memexId,
    title: "Database Standard",
    body: `Use Postgres [per dec-${decSeq}].`,
    docType: "standard",
  });

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const tabA = await ctxA.newPage();
  const tabB = await ctxB.newPage();

  await tabA.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${spec.docId}?decision=dec-${decSeq}`),
  );
  await tabB.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/standards`));

  // Initial state: standard card visible, no drift badge.
  await expect(tabB.getByText(/Database Standard/)).toBeVisible({ timeout: 15_000 });
  await expect(tabB.getByTestId("standard-drift-count")).toHaveCount(0);

  // Resolve the decision via the TENANT-SCOPED REST surface (UUID-keyed; dev user
  // resolved server-side). The flat /api/decisions mount resolves the memex from
  // the caller's SINGLE membership — the dev user now belongs to many memexes
  // (personal + every seeded org tenant), so flat is std-5-ambiguous and 4xxs;
  // the path-prefixed mount scopes the memex unambiguously [per std-2, std-5].
  // resolveDecision emits the drift event on the bus.
  const resolveResp = await tabA.request.post(
    `${API_URL}/api/${tenant.namespaceSlug}/${tenant.memexSlug}/decisions/${decisionId}/resolve`,
    {
      data: { resolution: "Postgres it is." },
      headers: { "Content-Type": "application/json" },
    },
  );
  expect(resolveResp.ok()).toBeTruthy();

  // Tab B should pick up the drift via SSE → StandardList re-fetches with
  // include=driftCount → badge appears.
  await expect(tabB.getByTestId("standard-drift-count")).toBeVisible({ timeout: 15_000 });
  await expect(tabB.getByTestId("standard-drift-count")).toHaveText(/drift/);

  await ctxA.close();
  await ctxB.close();
});
