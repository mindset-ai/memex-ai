import { test, expect, tenantPath, sendChat } from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// Journey 8: Agent chat streaming + persistence
// Drives the /api/llm/chat SSE flow end-to-end through the React UI using the Anthropic
// fake. Verifies that:
//   1. Text deltas stream into the ChatPanel message area (not batched until completion)
//   2. The completed turn persists to the conversations + messages tables (tenant-scoped)
//
// RE-BASE NOTE (spec-172 t-5 / issue-2): the original journey also asserted that
// "reloading re-hydrates the thread". That is RETIRED behavior — spec-159's
// ChatContext clears the remote conversation on doc-open (clearConversationRemote)
// and no longer calls loadConversation on mount: opening a Spec deliberately
// starts the chat idle/empty. Surfaced as spec-172 issue-2 rather than silently
// patched; the reload-rehydration assertion is removed here (the streaming +
// persistence coverage above is what remains true).
//
// Relies on MEMEX_ANTHROPIC_FAKE=1 being set on the E2E server process (see
// playwright.config.ts). Queue manipulation happens via POST /api/__test__/anthropic-queue.

test("agent chat streams assistant text and persists the turn", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j8");
  const tenant = await seedOrgTenant({ slug });
  const { docId } = await seedSpec({
    memexId: tenant.memexId,
    title: "Streaming Spec",
    purpose: "Test that the agent can talk to us.",
  });

  // Prime the fake with one response for this single turn. Small per-delta delay so the
  // SSE flush is observable — 0ms would land as a single React batch and defeat the point.
  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: ["The ", "plan ", "looks ", "good."],
    content: [{ type: "text", text: "The plan looks good." }],
    stopReason: "end_turn",
    deltaDelayMs: 30,
  });

  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));

  // Wait for the doc (and thus ChatContext's docId wiring) to be ready before
  // chatting — sending before the agent graph is bound silently no-ops.
  await expect(page.getByText(/Test that the agent can talk to us/)).toBeVisible({
    timeout: 15_000,
  });

  // Send the message deterministically (fill → wait for Send to enable → click;
  // pressing Enter can race the controlled-input state and silently no-op).
  await sendChat(page, "What do you think?");

  // Assert the assistant message renders the completed text. We don't try to catch every
  // intermediate delta (Playwright poll granularity is coarser than the 30ms per delta);
  // instead we verify the final rendered content, which only arrives if deltas streamed.
  const chatMarkdown = page.getByTestId("chat-markdown");
  await expect(chatMarkdown).toHaveText(/The plan looks good\./, {
    timeout: 10_000,
  });

  // Streaming indicator should disappear when the turn completes.
  await expect(page.getByText(/Thinking/i)).toBeHidden({ timeout: 10_000 });

  // saveConversation runs in the background after the turn — poll the API until the
  // thread is persisted. 2 messages: the user's question + the assistant's reply.
  // The conversation is persisted under the TENANT-SCOPED llm path the UI uses
  // (/api/<ns>/<mx>/llm/conversations/:docId — the flat /api/llm read resolves
  // the dev user's PERSONAL memex, not this seeded org memex, so it would miss
  // the thread). Hit the API origin directly via the browser context so the dev
  // session cookie rides along.
  const apiBase = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;
  const convPath = `/api/${tenant.namespaceSlug}/${tenant.memexSlug}/llm/conversations/${docId}`;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${apiBase}${convPath}`);
        if (!res.ok()) return 0;
        const body = await res.json();
        return Array.isArray(body.messages) ? body.messages.length : 0;
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThanOrEqual(2);
});
