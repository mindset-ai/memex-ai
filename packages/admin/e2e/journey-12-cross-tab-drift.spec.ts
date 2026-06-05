import { test, expect, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, seedDoc } from "./helpers/db.js";
import postgres from "postgres";

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/memex";

// Journey 12 (t-19 W5): Cross-tab drift round-trip (covers t-18). Resolve a
// referenced decision in tab A; the drift dot should appear on the referencing
// standard in tab B without a manual refresh — proves the SSE drift event
// from services/decisions.ts::resolveDecision propagates into the StandardList
// page's useDocChangeStream subscription.

test("resolving a decision in one tab lights the drift badge on a standard in another", async ({
  browser,
  resources,
}) => {
  const subdomain = resources.subdomain("j12");
  const accountId = await seedAccount({ subdomain, name: "Cross-tab Drift Test" });
  resources.accountIds.push(accountId);
  await resources.devAsAdmin(accountId);

  // Seed a spec with one open decision, plus a standard whose section
  // references that decision via the conventional `[per dec-N]` form.
  const sql = postgres(DATABASE_URL);
  let specDocId: string;
  let decisionId: string;
  let decSeq: number;
  let standardHandle: string;
  try {
    const spec = await seedDoc({
      accountId,
      handle: "doc-1",
      title: "Spec with Decision",
      purpose: "Spec purpose.",
    });
    specDocId = spec.docId;

    const [dec] = await sql<{ id: string; seq: number }[]>`
      INSERT INTO decisions (account_id, doc_id, seq, title, status)
      VALUES (${accountId}, ${specDocId}, 1, 'Pick database', 'open')
      RETURNING id, seq
    `;
    decisionId = dec.id;
    decSeq = dec.seq;

    const standard = await seedDoc({
      accountId,
      handle: "doc-2",
      title: "Database Standard",
      purpose: `Use Postgres [per dec-${decSeq}].`,
      docType: "standard",
    });
    standardHandle = "doc-2";
    // Make sure the section content carries the per-dec-N reference so the
    // FTS scan in scanForDecisionDrift matches.
    await sql`
      UPDATE doc_sections
      SET content = ${`Use Postgres [per dec-${decSeq}].`}
      WHERE doc_id = ${standard.docId}
    `;
  } finally {
    await sql.end();
  }

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const tabA = await ctxA.newPage();
  const tabB = await ctxB.newPage();

  await tabA.goto(tenantUrl(subdomain, `/docs/${specDocId}?decision=dec-${decSeq}`));
  await tabB.goto(tenantUrl(subdomain, `/standards`));

  // Initial state: standard card visible, no drift badge.
  await expect(
    tabB.getByText(/Database Standard/),
  ).toBeVisible({ timeout: 15_000 });
  await expect(tabB.getByTestId("standard-drift-count")).toHaveCount(0);

  // Resolve the decision in tab A via the API (the UI affordance changes per
  // dec status; hitting the REST surface keeps the test focused on the SSE
  // round-trip rather than the resolution dialog).
  // The e2e harness runs the API on $E2E_SERVER_PORT (default 8090) so it
  // doesn't collide with a `make dev` server on 8080. Build the URL off that.
  const apiPort = process.env.E2E_SERVER_PORT ?? "8090";
  const resolveResp = await tabA.request.post(
    tenantUrl(subdomain, `/api/decisions/${decisionId}/resolve`).replace(":5173", `:${apiPort}`),
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
  // suppress unused-var warning for standardHandle (kept for future assertions)
  void standardHandle;
});
