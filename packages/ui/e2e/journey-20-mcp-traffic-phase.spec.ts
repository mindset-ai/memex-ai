// Journey 20 — spec-189: automatic phase advancement + assignment from MCP
// traffic, observed live on the Kanban board [per std-28].
//
// The user-facing promise (ac-1): someone working a Spec exclusively through
// the MCP server — never touching the web UI — still sees that Spec
// represented truthfully on the board: traffic moves the card between phase
// columns and the caller appears as an assignee, live over SSE.
//
// The journey drives REAL MCP-channel traffic at `/mcp` (Bearer
// mxt_DEV_LOCAL_ONLY_NEVER_PRODUCTION — the dev-only PAT the e2e webServer
// accepts because GOOGLE_CLIENT_ID="" puts it in dev mode, resolving to
// dev@memex.ai). REST traffic deliberately can't stand in here: spec-189
// dec-5 makes rest_ui inert by design — only the agent channels move Specs.
//
//   1. Seed an org tenant (owner dev@memex.ai) + a draft Spec; open the board.
//   2. Card sits in Draft, unassigned.
//   3. MCP create_decision (specify-class) → card moves to Specify AND grows
//      the dev user's assignee avatar — no page interaction at all.
//   4. MCP create_task (build-class) → card moves on to Build.
//
// Emits ac-1 + ac-4 per the ac-emission discipline (pass AND fail).

import { test, expect, bareUrl } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  type SeededOrgTenant,
} from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/emit-ac.js";

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-189/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-189/acs/ac-4",
];

const DEV_MCP_BEARER = "mxt_DEV_LOCAL_ONLY_NEVER_PRODUCTION";

// `/mcp` is served by the API server directly (the Vite proxy only carries
// /api/*), so target the server port — same env chain as helpers/retained.ts.
const MCP_URL =
  (process.env.E2E_API_URL ??
    `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`) + "/mcp";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-20-mcp-traffic-phase.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

/** Call a real MCP tool over the wire, exactly as a coding agent would. */
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
  expect(res.ok(), `MCP ${name} should succeed (got ${res.status()})`).toBeTruthy();
  const text = await res.text();
  // The streamable transport answers as SSE; the tool result rides the first
  // data: line. A tool-level error carries isError — surface it loudly.
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  expect(dataLine, `MCP ${name} returned no SSE data: ${text}`).toBeTruthy();
  const payload = JSON.parse(dataLine!.slice(6));
  expect(
    payload.result?.isError,
    `MCP ${name} tool error: ${payload.result?.content?.[0]?.text}`
  ).toBeFalsy();
}

test("MCP traffic moves the Spec card across the board and assigns the caller, live", async ({
  page,
  resources,
}) => {
  // ── 1. Seed tenant + draft Spec, open the Specs board ────────────────────
  const slug = resources.slug("traffic");
  const tenant: SeededOrgTenant = await seedOrgTenant({ slug });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Worked entirely over MCP",
    purpose: "spec-189 journey subject.",
  });
  const specRef = `${tenant.namespaceSlug}/${tenant.memexSlug}/specs/${spec.handle}`;

  await page.goto(bareUrl(`/${tenant.namespaceSlug}/${tenant.memexSlug}`));
  const board = page.getByTestId("kanban-board");
  await expect(board).toBeVisible({ timeout: 15_000 });

  // Column locator: the column root carries its phase heading; scope card
  // lookups inside it so "which column is the card in" is unambiguous.
  const column = (label: string) =>
    board
      .locator("div.flex.flex-col", {
        has: page.getByRole("heading", { name: label, exact: true }),
      })
      .first();
  // Card titles render with a board-sequence prefix ("1.Worked entirely…"),
  // so match on substring, scoped to the column.
  const card = (col: ReturnType<typeof column>) =>
    col.getByText("Worked entirely over MCP");

  // ── 2. The seeded Spec sits in Draft ─────────────────────────────────────
  await expect(card(column("Draft"))).toBeVisible({ timeout: 15_000 });

  // ── 3. Specify-class MCP traffic: decision authoring ─────────────────────
  // No UI interaction from here on — the board must follow the traffic.
  await mcpToolCall(page.request, "create_decision", {
    ref: specRef,
    title: "Which queue do we use?",
  });

  // The card moves Draft → Specify over SSE (status_changed on the bus)…
  await expect(card(column("Specify"))).toBeVisible({ timeout: 15_000 });
  await expect(card(column("Draft"))).not.toBeVisible();
  // …and the calling user (dev) is now an assignee on the card (dec-6 also
  // makes them an editor server-side; the card surfaces the avatar).
  const specifyCard = column("Specify").locator('[data-testid="spec-assignees"]');
  await expect(specifyCard).toBeVisible({ timeout: 15_000 });

  // ── 4. Build-class MCP traffic: task creation ────────────────────────────
  await mcpToolCall(page.request, "create_task", {
    ref: specRef,
    title: "Wire the queue",
    description: "Implementation begins.",
  });

  await expect(card(column("Build"))).toBeVisible({ timeout: 15_000 });
  await expect(card(column("Specify"))).not.toBeVisible();
});
