// Journey 20 — spec-464: MCP traffic NEVER moves a Spec's phase as a side
// effect, and an ahead-of-phase agent call is refused, observed live on the
// Kanban board [per std-28].
//
// This journey inverts the old spec-189 promise (traffic auto-advanced the
// card across columns). spec-464 dec-1 removed traffic-driven advancement:
//
//   ac-1 — a Spec worked exclusively through MCP is represented truthfully: its
//          phase does NOT change as a side effect of tool calls. The card stays
//          in the column the human placed it in. (Auto-assign still fires — the
//          caller appears as an assignee — that behaviour was never the bug.)
//   ac-2 — an ahead-of-phase agent call (a build-home tool on a draft Spec) is
//          refused: the tool returns isError, and the card does not move.
//
// Drives REAL MCP-channel traffic at `/mcp` (Bearer
// mxt_DEV_LOCAL_ONLY_NEVER_PRODUCTION — the dev-only PAT the e2e webServer
// accepts because GOOGLE_CLIENT_ID="" puts it in dev mode, resolving to
// dev@memex.ai). rest_ui is inert by design; only agent channels hit the seam.
//
// Emits ac-1 + ac-2 per the ac-emission discipline (pass AND fail).

import { test, expect, bareUrl, seedTask } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  type SeededOrgTenant,
} from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/emit-ac.js";

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-464/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-464/acs/ac-2",
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

/** Call a real MCP tool over the wire, exactly as a coding agent would. Returns
 *  the parsed tool result so the caller can assert on isError / text. */
async function mcpToolCall(
  request: import("@playwright/test").APIRequestContext,
  name: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; text: string }> {
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
  expect(res.ok(), `MCP ${name} HTTP transport should respond (got ${res.status()})`).toBeTruthy();
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  expect(dataLine, `MCP ${name} returned no SSE data: ${text}`).toBeTruthy();
  const payload = JSON.parse(dataLine!.slice(6));
  return {
    isError: Boolean(payload.result?.isError),
    text: String(payload.result?.content?.[0]?.text ?? ""),
  };
}

test("MCP traffic never moves the Spec card, and an ahead-of-phase call is refused, live", async ({
  page,
  resources,
}) => {
  // ── 1. Seed tenant + draft Spec (with a pre-seeded task), open the board ──
  const slug = resources.slug("traffic");
  const tenant: SeededOrgTenant = await seedOrgTenant({ slug });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Worked entirely over MCP",
    purpose: "spec-464 journey subject.",
  });
  const specRef = `${tenant.namespaceSlug}/${tenant.memexSlug}/specs/${spec.handle}`;

  // Seed a task guard-exempt via the test surface (no agent channel), so we can
  // drive an ahead-of-phase update_task at it. It does not move the phase (draft).
  const seededTask = await seedTask({
    memexId: tenant.memexId,
    docId: spec.docId,
    title: "Wire the queue",
    description: "Implementation begins.",
  });
  const taskRef = `${specRef}/tasks/t-${seededTask.seq}`;

  // spec-498: the bare tenant index now renders Trails, so navigate to the explicit
  // Specs board — this journey watches a Spec CARD on the board, not the graph.
  await page.goto(bareUrl(`/${tenant.namespaceSlug}/${tenant.memexSlug}/specs`));
  const board = page.getByTestId("kanban-board");
  await expect(board).toBeVisible({ timeout: 15_000 });

  const column = (label: string) =>
    board
      .locator("div.flex.flex-col", {
        has: page.getByRole("heading", { name: label, exact: true }),
      })
      .first();
  const card = (col: ReturnType<typeof column>) =>
    col.getByText("Worked entirely over MCP");

  // ── 2. The seeded Spec sits in Draft ─────────────────────────────────────
  await expect(card(column("Draft"))).toBeVisible({ timeout: 15_000 });

  // ── 3. Specify-class MCP traffic does NOT move the card (ac-1) ────────────
  // create_decision on a draft Spec is allowed (with a publish nudge) but must
  // NOT advance the phase — spec-464 dec-1. The caller is still auto-assigned.
  const decRes = await mcpToolCall(page.request, "create_decision", {
    ref: specRef,
    title: "Which queue do we use?",
  });
  expect(decRes.isError, `create_decision should succeed: ${decRes.text}`).toBeFalsy();

  // The auto-assign avatar appears on the (still-Draft) card, proving the tool
  // ran — yet the card has NOT left Draft.
  const draftAssignees = column("Draft").locator('[data-testid="spec-assignees"]');
  await expect(draftAssignees).toBeVisible({ timeout: 15_000 });
  await expect(card(column("Draft"))).toBeVisible();
  await expect(card(column("Specify"))).not.toBeVisible();

  // ── 4. Build-home MCP traffic ahead of phase is REFUSED (ac-2) ────────────
  // update_task is home 'build'; on a draft Spec it is refused with no write and
  // no phase move.
  const refused = await mcpToolCall(page.request, "update_task", {
    ref: taskRef,
    title: "Wire the queue — implementation begins",
  });
  expect(refused.isError, "update_task ahead of build must be refused").toBeTruthy();

  // The card is still in Draft — the refusal moved nothing.
  await expect(card(column("Draft"))).toBeVisible({ timeout: 15_000 });
  await expect(card(column("Build"))).not.toBeVisible();
  await expect(card(column("Specify"))).not.toBeVisible();
});
