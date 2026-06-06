import { test, expect, tenantPath, switchToEditing, sendChat } from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// Journey 14 (t-19 W5): Candidate decision approve/reject (covers t-16). The
// agent extracts a decision via propose_decision; the UI shows the candidate
// with options; the user clicks Approve; status flips to open and the panel
// updates live via SSE.

test("agent proposes a candidate decision, user approves, status flips to open", async ({
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

  // Two messages stream into the chat (user prompt + agent reply); the
  // assistant's reply is the last chat-markdown node.
  await expect(page.getByTestId("chat-markdown").last()).toHaveText(/Candidate filed/i, {
    timeout: 15_000,
  });

  // Open the Decisions & ACs sub-tab (the plan/Specify phase's second sub-tab,
  // post spec-164 phase-tab redesign — was a bare "Decisions" tab pre-rebase).
  // Rendered as a <button> by Tabs, not the ARIA `tab` role.
  await page.getByRole("button", { name: /^Decisions & ACs$/i }).click();

  // DecisionPanel's `activeTab` initialises before the SSE-driven decisions
  // refetch lands, so when the candidate arrives after the first paint the
  // panel may still be on Open. Click into the Candidates sub-tab explicitly.
  await page.getByRole("button", { name: /^Candidates 1$/i }).click();

  // Approve the candidate. Per t-16 the Approve button has data-testid="candidate-approve".
  await page.getByTestId("candidate-approve").click();

  // The approval flips the decision candidate → open. The DecisionPanel re-fetches
  // on the SSE `decision updated` event and auto-switches to the Open tab; the
  // decision now renders there. The old raw-SQL status poll is dropped (the e2e
  // package has no Postgres dependency, dec-2) — the UI surfacing the decision
  // under Open is the server-backed proof the status flipped (the panel reads the
  // API, not local state).
  await expect(page.getByRole("button", { name: /^Open 1$/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /^Open 1$/i }).click();
  await expect(page.getByText("Pick database").first()).toBeVisible({
    timeout: 15_000,
  });
});
