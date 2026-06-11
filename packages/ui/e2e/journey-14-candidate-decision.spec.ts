import { test, expect, tenantPath, switchToEditing, sendChat } from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// Journey 14 (t-19 W5, rewritten under spec-247 dec-6): the candidate-decision
// flow. The agent extracts a decision via create_decision(status:'candidate');
// the UI shows the candidate VIEW-ONLY — options render as information (no
// radios), there are no web Approve/Reject controls, and the card list carries
// the coding-agent boundary marker (ac-20 / ac-21). Approval happens
// agent-side (approve_candidate over the shared tool catalog); the panel
// updates live via SSE when it does.

test("candidate decisions are view-only on the web; approval happens agent-side and the panel updates live", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j14");
  const tenant = await seedOrgTenant({ slug });
  const { docId, handle } = await seedSpec({
    memexId: tenant.memexId,
    title: "Candidate Spec",
    purpose: "We need to decide.",
  });

  // create_decision (which replaced propose_decision) is keyed by the canonical
  // doc REF and takes status:"candidate" for the agent-extracted candidate path.
  const docRef = `${tenant.namespaceSlug}/${tenant.memexSlug}/specs/${handle}`;

  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: ["Looking at the options."],
    content: [
      { type: "text", text: "Looking at the options." },
      {
        type: "tool_use",
        id: "toolu_j14_prop",
        name: "create_decision",
        input: {
          ref: docRef,
          title: "Pick database",
          context: "Two options considered.",
          status: "candidate",
          options: [
            { label: "Postgres", trade_offs: "Familiar; SQL." },
            { label: "DynamoDB", trade_offs: "Scales; weaker queries." },
          ],
        },
      },
    ],
    stopReason: "tool_use",
  });
  await queueAnthropicResponse({
    textDeltas: ["Candidate ", "filed."],
    content: [{ type: "text", text: "Candidate filed." }],
    stopReason: "end_turn",
  });

  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));
  await expect(page.getByText(/We need to decide/)).toBeVisible({ timeout: 15_000 });

  // create_decision is an editor-only agent tool; promote out of review posture.
  await switchToEditing(page);

  await sendChat(page, "postgres or dynamodb for the catalog?");

  await expect(page.getByTestId("chat-markdown").last()).toHaveText(/Candidate filed/i, {
    timeout: 15_000,
  });

  // Open the Decisions & ACs sub-tab and the Candidates sub-tab.
  await page.getByRole("button", { name: /^Decisions & ACs$/i }).click();
  await page.getByRole("button", { name: /^Candidates 1$/i }).click();

  const panel = page.getByTestId("decision-panel");

  // spec-247 ac-20 — view-only: the options render as information…
  await expect(panel.getByText("Postgres")).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText(/Familiar; SQL/)).toBeVisible();
  // …with NO selectable radios and NO web approval controls.
  await expect(panel.getByRole("radio")).toHaveCount(0);
  await expect(panel.getByTestId("candidate-approve")).toHaveCount(0);
  await expect(panel.getByTestId("candidate-reject")).toHaveCount(0);

  // spec-247 ac-21 — the boundary marker says where approval DOES happen.
  const marker = panel.getByTestId("candidate-mcp-marker");
  await expect(marker).toBeVisible();
  await expect(marker).toContainText(/Review the candidate decisions/);
  await expect(marker).toContainText(/not in the browser/i);

  // Approval happens agent-side: the spec assistant (same tool catalog as the
  // MCP coding agents, spec-14 dec-4) calls approve_candidate; the panel
  // refetches on the SSE `decision updated` event and the decision surfaces
  // under Open — the server-backed proof the status flipped.
  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: ["Approving."],
    content: [
      { type: "text", text: "Approving." },
      {
        type: "tool_use",
        id: "toolu_j14_appr",
        name: "approve_candidate",
        input: { ref: `${docRef}/decisions/dec-1` },
      },
    ],
    stopReason: "tool_use",
  });
  await queueAnthropicResponse({
    textDeltas: ["Approved — it's an open decision now."],
    content: [{ type: "text", text: "Approved — it's an open decision now." }],
    stopReason: "end_turn",
  });

  await sendChat(page, "yes, that's a real decision — approve it");

  await expect(page.getByRole("button", { name: /^Open 1$/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /^Open 1$/i }).click();
  await expect(page.getByText("Pick database").first()).toBeVisible({
    timeout: 15_000,
  });
});
