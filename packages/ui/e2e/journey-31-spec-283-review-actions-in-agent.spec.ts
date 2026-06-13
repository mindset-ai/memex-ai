import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, setDocStatus } from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/emit-ac.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// Journey 31 (spec-283): the four Spec review actions have moved OFF the Spec
// page and INTO the agent's idle/empty state.
//
// This journey exercises the relocation end-to-end on a Specify-phase Spec
// (std-28): the four buttons live in the ChatPanel idle state under the lead
// "Ask a question, or start with a review:"; clicking one starts the
// conversation and the buttons vanish with the empty state. The Spec page no
// longer carries the "Review actions" disclosure or the button row, while the
// coding-agent review-handoff copy line still renders in Specify.

const SPEC283 = "mindset-prod/memex-building-itself/specs/spec-283";

const ACS_BY_TEST: Record<string, string[]> = {
  "review actions live in the agent idle state, not on the Spec page": [
    `${SPEC283}/acs/ac-5`, // relocation preserves coverage + ships an e2e journey
    `${SPEC283}/acs/ac-1`, // buttons appear in the idle state; clicking starts the review
    `${SPEC283}/acs/ac-2`, // idle-only — they disappear once a conversation starts
    `${SPEC283}/acs/ac-3`, // the page no longer shows the row; handoff line stays
  ],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TEST[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-31-spec-283-review-actions-in-agent.spec.ts::${testInfo.title}`,
    testInfo.duration
  );
});

test("review actions live in the agent idle state, not on the Spec page", async ({
  page,
  resources,
}) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j31") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Review actions relocation",
    purpose: "Exercise the relocated review actions in the agent idle state.",
  });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "specify" });

  // Clicking a review button fires an agent turn — prime the fake so the turn
  // completes cleanly rather than erroring.
  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: ["Here ", "is ", "the ", "summary."],
    content: [{ type: "text", text: "Here is the summary." }],
    stopReason: "end_turn",
    deltaDelayMs: 10,
  });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`)
  );

  // The agent panel has mounted (its heading is always present). The Specify
  // overview prose sits behind the Narrative sub-tab, so it's not a reliable
  // page-load anchor — the panel heading is.
  await expect(page.getByText("Spec assistant")).toBeVisible({ timeout: 15_000 });

  // ── The agent idle state carries the four review buttons (ac-1) ──
  // The block only renders once the bound doc is a Spec in Specify with an idle
  // conversation, so its visibility also proves ChatContext's doc is bound.
  const reviewBlock = page.getByTestId("agent-review-actions");
  await expect(reviewBlock).toBeVisible({ timeout: 15_000 });
  await expect(reviewBlock).toContainText("Ask a question, or start with a review:");
  for (const label of [
    "Summarise Spec",
    "Security review",
    "Design review",
    "Architecture review",
  ]) {
    await expect(reviewBlock.getByRole("button", { name: label })).toBeVisible();
  }

  // ── The Spec page no longer carries the disclosure or the button row, but the
  //    review-handoff copy line stays (ac-3, dec-4) ──
  await expect(page.getByTestId("review-actions-toggle")).toHaveCount(0);
  await expect(page.getByTestId("review-action-row")).toHaveCount(0);
  await expect(page.getByTestId("review-handoff-line")).toBeVisible({ timeout: 15_000 });

  // ── Clicking one starts the review; the idle buttons vanish (ac-1, ac-2) ──
  await reviewBlock.getByRole("button", { name: "Summarise Spec" }).click();

  // The conversation has started: the assistant's streamed reply renders and the
  // idle review block is gone (it only shows while messages.length === 0).
  await expect(page.getByTestId("chat-markdown")).toHaveText(/Here is the summary\./, {
    timeout: 10_000,
  });
  await expect(page.getByTestId("agent-review-actions")).toHaveCount(0);
});
