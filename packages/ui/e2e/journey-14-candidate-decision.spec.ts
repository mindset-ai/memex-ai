import { test, expect, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, seedDoc } from "./helpers/db.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";
import postgres from "postgres";

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/memex";

// Journey 14 (t-19 W5): Candidate decision approve/reject (covers t-16). The
// agent extracts a decision via propose_decision; the UI shows the candidate
// with options; the user clicks Approve; status flips to open and the panel
// updates live via SSE.

test("agent proposes a candidate decision, user approves, status flips to open", async ({
  page,
  resources,
}) => {
  const subdomain = resources.subdomain("j14");
  const accountId = await seedAccount({
    subdomain,
    name: "Candidate Decision Test",
  });
  resources.accountIds.push(accountId);
  await resources.devAsAdmin(accountId);

  const { docId } = await seedDoc({
    accountId,
    handle: "doc-1",
    title: "Candidate Spec",
    purpose: "We need to decide.",
  });

  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: ["Looking at the options."],
    content: [
      { type: "text", text: "Looking at the options." },
      {
        type: "tool_use",
        id: "toolu_j14_prop",
        name: "propose_decision",
        input: {
          docId,
          title: "Pick database",
          context: "Two options considered.",
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

  await page.goto(tenantUrl(subdomain, `/docs/${docId}`));
  await expect(page.getByText(/We need to decide/)).toBeVisible({ timeout: 15_000 });

  const input = page.getByPlaceholder(/Ask me anything/i);
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.fill("postgres or dynamodb for the catalog?");
  await input.press("Enter");

  // Two messages stream into the chat (user prompt + agent reply); the
  // assistant's reply is the last chat-markdown node.
  await expect(page.getByTestId("chat-markdown").last()).toHaveText(/Candidate filed/i, {
    timeout: 15_000,
  });

  // Open the decisions tab — Tabs are rendered as <button>, not <tab> role.
  await page.getByRole("button", { name: /^Decisions$/i }).click();

  // DecisionPanel's `activeTab` initialises before the SSE-driven decisions
  // refetch lands, so when the candidate arrives after the first paint the
  // panel may still be on Open. Click into the Candidates sub-tab explicitly.
  await page.getByRole("button", { name: /^Candidates 1$/i }).click();

  // Approve the candidate. Per t-16 the Approve button has data-testid="candidate-approve".
  await page.getByTestId("candidate-approve").click();

  // Verify status flipped server-side.
  const sql = postgres(DATABASE_URL);
  try {
    let opened = false;
    for (let i = 0; i < 30; i++) {
      const rows = await sql<{ status: string }[]>`
        SELECT status FROM decisions WHERE account_id = ${accountId} AND title = 'Pick database'
      `;
      if (rows[0]?.status === "open") {
        opened = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(opened).toBe(true);
  } finally {
    await sql.end();
  }
});
