import { test, expect, tenantPath, switchToEditing, sendChat } from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

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
  const slug = resources.slug("j9");
  const tenant = await seedOrgTenant({ slug });
  const { docId, handle } = await seedSpec({
    memexId: tenant.memexId,
    title: "Tool-use Spec",
    purpose: "Seed purpose text",
  });

  // The add_section tool is keyed by the canonical doc REF, not a raw docId
  // (tool-specs.ts: resolveRefArg). Build it from the tenant slugs + handle.
  const docRef = `${tenant.namespaceSlug}/${tenant.memexSlug}/specs/${handle}`;

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
          ref: docRef,
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

  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));

  // Wait for the doc to render — the seeded "Purpose" section must be visible before we
  // assert the new section appears, otherwise we'd be racing the initial fetchDoc call.
  await expect(page.getByText(/Seed purpose text/)).toBeVisible({
    timeout: 15_000,
  });

  // add_section is an editor-only agent tool; the dev user opens a seeded Spec in
  // REVIEW posture (no editor doc_members row). Promote to Editing first.
  await switchToEditing(page);

  await sendChat(page, "add an approach section");

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

  // The text only renders if the SSE doc_change event triggered a reloadDoc that
  // re-fetched the persisted section from the server — i.e. it landed in Postgres
  // and round-tripped back. The old raw-SQL guard is dropped (the e2e package has
  // no Postgres dependency, dec-2); this server-backed re-fetch is the
  // not-from-cache proof, since reloadDoc reads the API, not React state.
});
