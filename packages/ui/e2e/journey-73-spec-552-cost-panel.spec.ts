// Journey 73 — spec-552: a member sees what Memex sent their agents, computed
// from real traffic, on the Insights page [per std-28].
//
//   ac-1 — both halves of every payload are recoverable from telemetry: the
//          whole response AND the platform guidance inside it. Proven here the
//          only way that really counts — the guidance share on screen is
//          derived from footer bytes that REAL MCP calls wrote.
//   ac-2 — a member sees, without leaving the product, how much Memex sent
//          their agents over a stated window and what share was guidance,
//          per operation, with a median and a p90 rather than one average.
//   ac-3 — the figures are computed, not authored: nothing is seeded into the
//          card, and the numbers appear only because tool calls happened.
//   ac-23/ac-24 — a per-operation p90 appears only where the row has enough
//          calls to support one, and is withheld with a stated reason where it
//          does not. Both sides come from real traffic at two volumes, so the
//          threshold is exercised end to end rather than mocked.
//
// SEEDING IS REAL TRAFFIC, not fixture rows. The journey drives actual MCP
// tool calls at `/mcp` (the same shape journey-20 uses), so `mcp_tool_calls`
// is written by the production path — including `result_text_length` and
// `footer_text_length`. No raw SQL [per std-28]; the tenant and Spec come from
// the env-gated `/api/__test__` surface.
//
// WHAT THIS JOURNEY DOES NOT COVER, and why. The rollout gate reads
// COST_PANEL_MEMEXES from the server env, which playwright.config.ts fixes to
// "*" for the whole run (matching int, per dec-8). A journey therefore cannot
// flip the gate, so the CARD-ABSENT state is proven one tier down: the
// component renders null for an unavailable payload (CostPanelCard.test.tsx)
// and the endpoint returns byte-identical closed responses for both closed
// reasons (analytics-cost-panel*.integration.test.ts). Making it flippable
// would need either a deterministic tenant slug — which breaks CI retries,
// because seed-org is not idempotent — or a test endpoint that mutates server
// env, which costs more than the coverage it buys.

import { test, expect } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  type SeededOrgTenant,
} from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/emit-ac.js";

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-552/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-552/acs/ac-2",
  "mindset-prod/memex-building-itself/specs/spec-552/acs/ac-3",
  "mindset-prod/memex-building-itself/specs/spec-552/acs/ac-23",
  "mindset-prod/memex-building-itself/specs/spec-552/acs/ac-24",
];

const DEV_MCP_BEARER = "mxt_DEV_LOCAL_ONLY_NEVER_PRODUCTION";

const MCP_URL =
  (process.env.E2E_API_URL ??
    `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`) + "/mcp";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-73-spec-552-cost-panel.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

/** Drive one real MCP tool call, exactly as a coding agent would. */
async function mcpToolCall(
  request: import("@playwright/test").APIRequestContext,
  name: string,
  args: Record<string, unknown>
): Promise<void> {
  const res = await request.post(MCP_URL, {
    headers: {
      Authorization: `Bearer ${DEV_MCP_BEARER}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(
    res.ok(),
    `MCP ${name} should respond over HTTP (got ${res.status()})`
  ).toBeTruthy();
}

test("the cost card reports real MCP traffic, per operation, with a median and a p90", async ({
  page,
  request,
  resources,
}) => {
  // ── 1. A tenant with a Spec to call tools against ──────────────────────────
  const slug = resources.slug("costpanel");
  const tenant: SeededOrgTenant = await seedOrgTenant({ slug });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Subject of the cost panel journey",
    purpose: "spec-552 journey subject.",
  });
  const specRef = `${tenant.namespaceSlug}/${tenant.memexSlug}/specs/${spec.handle}`;

  // ── 2. REAL traffic, ACROSS THE P90 FLOOR (dec-10) ────────────────────────
  //      Two operations at different volumes, so one row earns a p90 and the
  //      other is withheld — the threshold proved on the production path, not
  //      simulated from a fixture.
  //
  //      Ten get_doc calls clear MIN_CALLS_FOR_P90; get_doc responses also
  //      carry the platform footer, which is what makes the guidance share on
  //      screen a measurement rather than a constant.
  //      ONE list_tasks call sits below the floor.
  //      Eleven calls together clear MIN_CALLS_FOR_FIGURES (3) with room.
  //
  //      The literal 10 is deliberate here, and it is NOT the duplication
  //      ac-25 forbids: an e2e file cannot import a React module, and a
  //      mismatch with the constant reds this run loudly. What ac-25 protects
  //      against is a test that stays GREEN on the wrong side of the
  //      threshold, which is a unit-test hazard, not this one.
  for (let i = 0; i < 10; i += 1) {
    await mcpToolCall(request, "get_doc", { ref: specRef });
  }
  await mcpToolCall(request, "list_tasks", { ref: specRef });

  // ── 3. The card, on the page a member actually visits ─────────────────────
  await page.goto(`/${tenant.namespaceSlug}/${tenant.memexSlug}/insights`);

  const card = page.getByText("What Memex sent your agents").first();
  await expect(card).toBeVisible();

  // The window is stated, and it comes from the response (ac-2).
  await expect(page.getByText(/Last \d+ days/)).toBeVisible();

  // Per-operation rows, and the operation named is the one we really called.
  await expect(page.getByText("get_doc").first()).toBeVisible();

  // Median AND p90 — never one number standing in for both (ac-2). Asserted on
  // the column HEADERS by role: `getByText("p90").first()` matched the header
  // and would have stayed green with every value cell withheld — green for the
  // wrong reason, which is the failure this whole Spec keeps meeting.
  await expect(
    page.getByRole("columnheader", { name: /median/i })
  ).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /p90/i })).toBeVisible();

  // dec-10, both sides, from real traffic (ac-23 / ac-24):
  //   the 10-call row earns its p90, and the 1-call row is told it cannot.
  // The withheld cell's reason is spoken-only, so it is found by text, not
  // sight — exactly how a screen-reader user meets it.
  await expect(page.getByText(/too few calls for a p90/i)).toHaveCount(1);
  await expect(page.getByText("list_tasks").first()).toBeVisible();

  // Token figures are marked as estimates, and the characters behind them are
  // on the row so a reader can recompute.
  await expect(page.getByText(/≈/).first()).toBeVisible();
  await expect(page.getByText(/estimated from characters/i)).toBeVisible();

  // The refusal is on the card, not left to the reader to infer (ac-4's shape).
  await expect(page.getByText(/can't measure|cannot measure/i)).toBeVisible();

  // ── 4. ac-1, end to end: the guidance share is non-zero, which can only be
  //      true if footer_text_length was captured on those calls alongside the
  //      whole-response length. A fixture cannot fake this — the footer was
  //      written by the server on a real Spec-tool response.
  await expect(page.getByText("Of that, platform guidance")).toBeVisible();
  const guidanceCell = page
    .locator("div", { hasText: /^Of that, platform guidance$/ })
    .first();
  await expect(guidanceCell).toBeVisible();
  // Any non-zero percentage proves both halves landed. Asserting a specific
  // number would pin the guidance envelope, which spec-510 is about to change.
  await expect(page.getByText(/[1-9]\d?%/).first()).toBeVisible();

  // ── 5. The page is otherwise intact — the ninth card is an addition, and a
  //      regression in it must not be mistaken for the page still working.
  await expect(page.getByRole("heading", { name: "Insights" })).toBeVisible();
});

test("a Memex with barely any traffic is told so, instead of shown a statistic", async ({
  page,
  request,
  resources,
}) => {
  const slug = resources.slug("costthin");
  const tenant: SeededOrgTenant = await seedOrgTenant({ slug });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Barely any traffic",
    purpose: "spec-552 thin-traffic subject.",
  });

  // ONE call — below MIN_CALLS_FOR_FIGURES. A median over one call is noise
  // wearing a statistic's clothes, so the card must refuse to draw it.
  await mcpToolCall(request, "get_doc", {
    ref: `${tenant.namespaceSlug}/${tenant.memexSlug}/specs/${spec.handle}`,
  });

  await page.goto(`/${tenant.namespaceSlug}/${tenant.memexSlug}/insights`);

  await expect(page.getByText("What Memex sent your agents")).toBeVisible();
  await expect(page.getByText(/not enough activity/i)).toBeVisible();
  // And no table: the header row is the tell.
  await expect(page.getByText("Median", { exact: false })).toHaveCount(0);
});
