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

// Journey 9: Agent tool execution + SSE propagation
// Exercises the full tool-use loop through the React UI + real server-side tool handler:
//   1. Agent turn 1 returns a tool_use block for add_section (server-executed)
//   2. Client POSTs to /api/llm/tools/execute → services/sections.ts#addSection runs
//   3. addSection emits a doc-change event over SSE (services/doc-events.ts)
//   4. The open DocDocument page's useDocChangeStream reloads the doc — the new section
//      appears in the UI WITHOUT a manual page reload
//   5. Client replays the loop with tool_result → agent turn 2 returns final text
//
// This is the test that catches regressions in the SSE payload shape, the add_section
// tool wiring, or the tool-result round-trip between the LangGraph client and the server.

test("agent tool_use creates a section and SSE propagates it to the open doc", async ({
  page,
  resources,
}) => {
  const subdomain = resources.subdomain("j9");
  const accountId = await seedAccount({ subdomain, name: "Tool-use Test" });
  resources.accountIds.push(accountId);
  await resources.devAsAdmin(accountId);

  const { docId } = await seedDoc({
    accountId,
    handle: "doc-1",
    title: "Tool-use Spec",
    purpose: "Seed purpose text",
  });

  // Queue two turns in order: the tool_use turn, then the follow-up text response the
  // agent produces after the tool_result comes back.
  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: [],
    content: [
      {
        type: "tool_use",
        id: "toolu_j9_add",
        name: "add_section",
        input: {
          docId,
          sectionType: "approach",
          title: "Approach",
          content:
            "We will tackle the work in three phases: discovery, build, rollout.",
        },
      },
    ],
    stopReason: "tool_use",
  });
  await queueAnthropicResponse({
    textDeltas: ["Section ", "added."],
    content: [{ type: "text", text: "Section added." }],
    stopReason: "end_turn",
  });

  await page.goto(tenantUrl(subdomain, `/docs/${docId}`));

  // Wait for the doc to render — the seeded "Purpose" section must be visible before we
  // assert the new section appears, otherwise we'd be racing the initial fetchDoc call.
  await expect(page.getByText(/Seed purpose text/)).toBeVisible({
    timeout: 15_000,
  });

  const input = page.getByPlaceholder(/Ask me anything/i);
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.fill("add an approach section");
  await input.press("Enter");

  // The agent's final text lands after the tool_result round-trip completes.
  const chatMarkdown = page.getByTestId("chat-markdown");
  await expect(chatMarkdown).toHaveText(/Section added\./, {
    timeout: 15_000,
  });

  // The newly-added section text must appear in the canvas WITHOUT a manual reload.
  // This is the SSE-driven UI update under test — useDocChangeStream receives the
  // doc_change event from services/doc-events.ts and triggers reloadDoc.
  await expect(
    page.getByText(/discovery, build, rollout/i)
  ).toBeVisible({ timeout: 15_000 });

  // And confirm against the DB that the section actually landed there (guards against a
  // UI regression where the section renders from cached state without hitting Postgres).
  const sql = postgres(DATABASE_URL);
  try {
    const rows = await sql<{ id: string; section_type: string }[]>`
      SELECT id, section_type FROM doc_sections
      WHERE doc_id = ${docId} AND section_type = 'approach'
    `;
    expect(rows).toHaveLength(1);
  } finally {
    await sql.end();
  }
});
