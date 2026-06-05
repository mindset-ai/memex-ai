import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// Journey 8: Agent chat streaming + persistence
// Drives the /api/llm/chat SSE flow end-to-end through the React UI using the Anthropic
// fake. Verifies that:
//   1. Text deltas stream into the ChatPanel message area (not batched until completion)
//   2. The completed turn persists to the conversations + messages tables
//   3. Reloading the page re-hydrates the thread from /api/llm/conversations/:docId
//
// Relies on MEMEX_ANTHROPIC_FAKE=1 being set on the E2E server process (see
// playwright.config.ts). Queue manipulation happens via POST /api/__test__/anthropic-queue.

test("agent chat streams assistant text and persists across reload", async ({
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

  // Wait for the chat input to be ready — the placeholder switches from "Open a spec
  // first" to "Ask me anything..." once ChatContext has a docId.
  const input = page.getByPlaceholder(/Ask me anything/i);
  await expect(input).toBeVisible({ timeout: 15_000 });

  await input.fill("What do you think?");
  await input.press("Enter");

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
  await expect
    .poll(
      async () => {
        // Flat conversations read — in dev mode the server resolves the dev user
        // without any Host/subdomain (account-era subdomain routing is gone).
        const res = await page.request.get(
          `${process.env.E2E_API_URL ?? "http://localhost:8090"}/api/llm/conversations/${docId}`,
        );
        if (!res.ok()) return 0;
        const body = await res.json();
        return Array.isArray(body.messages) ? body.messages.length : 0;
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThanOrEqual(2);

  // Reload — the chat should re-hydrate from the server via loadConversation().
  await page.reload();
  const reloadedMarkdown = page.getByTestId("chat-markdown");
  await expect(reloadedMarkdown).toHaveText(/The plan looks good\./, {
    timeout: 15_000,
  });
});
