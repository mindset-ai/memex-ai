import { test, expect, tenantPath, sendChat } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedStandard,
  seedClauses,
  seedProposal,
} from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// Journey 70 (spec-530 t-10): a proposal is read, accepted, and the Inbox clears itself.
//
// This is the flow the whole Spec exists to make possible. Before it, a proposal on a
// Standard could not be accepted AT ALL: the drift agent was told to apply one with
// `update_section`, which has thrown on every Standard since spec-161 made them
// clause-backed. The agent refused, correctly, and then invented an Accept button to get
// out of the corner.
//
// Journey 69 covers the READ half (the row shows current vs proposed). This one covers
// what 69 deliberately left out, and could not have run until t-4's verb and t-7's row
// were on the same branch:
//
//   1. the row shows the diff  →  2. the user tells the agent to accept
//   3. the agent calls accept_standard_change through /tools/execute (ONE verb, one
//      transaction — spec-530 dec-4)
//   4. the row disappears from the open Inbox with NO manual reload (the std-8 emit
//      contract, ac-12) and 5. the Standard's rule text really changed (ac-1).
//
// The accept is driven through the REAL agent path — a queued `tool_use` block against
// the server-side Anthropic fake — not by calling the endpoint. That matters: the Drift
// Inbox has no Accept control by design (spec-143 dec-3, restated in spec-530's
// non-goals), so conversation IS the user's path, and a journey that bypassed it would
// assert a flow no user has.
//
// Seeded through the env-gated test surface, never raw SQL [per std-28]; navigation is
// path-based [per std-2].

test("a proposal is read, accepted through the agent, and the Inbox clears itself", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j70");
  const tenant = await seedOrgTenant({ slug });

  const standard = await seedStandard({
    memexId: tenant.memexId,
    title: "Caching Standard",
    body: "",
  });
  const { clauseIds } = await seedClauses({
    memexId: tenant.memexId,
    sectionId: standard.sectionId,
    clauses: ["Cache every write.", "Invalidate on delete."],
  });

  const proposed = "Cache every write except mutating endpoints.";
  const proposal = await seedProposal({
    memexId: tenant.memexId,
    operations: [{ op: "edit", clauseId: clauseIds[0], body: proposed }],
    rationale: "The rule is too broad — it tells people to cache POSTs.",
  });

  // accept_standard_change takes the proposal's canonical comment ref and NOTHING else
  // (ac-11) — the proposal already carries what will be applied.
  const commentRef = `${tenant.namespaceSlug}/${tenant.memexSlug}/standards/${standard.handle}/comments/c-${proposal.commentSeq}`;

  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: [],
    content: [
      {
        type: "tool_use",
        id: "toolu_j70_accept",
        name: "accept_standard_change",
        input: { ref: commentRef },
      },
    ],
    stopReason: "tool_use",
  });
  await queueAnthropicResponse({
    textDeltas: ["Proposal ", "applied."],
    content: [{ type: "text", text: "Proposal applied." }],
    stopReason: "end_turn",
  });

  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/drift"));

  // ── 1. The row shows what the proposal actually says (ac-2) ──
  const row = page.getByTestId("drift-inbox-row").first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute("data-row-type", "proposal");

  await row.getByTestId("drift-proposal-toggle").click();
  const edit = page.getByTestId("drift-proposal-operation").first();
  await expect(edit.getByTestId("drift-proposal-current")).toContainText("Cache every write.");
  await expect(edit.getByTestId("drift-proposal-proposed")).toContainText(proposed);

  // ── 2. The user accepts in conversation — the only path there is ──
  await sendChat(page, "accept this proposal");

  await expect(page.getByTestId("chat-markdown")).toHaveText(/Proposal applied\./, {
    timeout: 20_000,
  });

  // ── 3. The Inbox clears ITSELF (ac-12) ──
  // No reload, no navigation. The row goes because accept_standard_change emitted on the
  // unified bus [per std-8] and the page's useDocChangeStream refetched. A silent accept
  // would leave this row on screen saying the work had not happened — the same defect
  // class the Spec was written to fix.
  await expect(page.getByTestId("drift-inbox-row")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("drift-empty-state")).toBeVisible({ timeout: 20_000 });

  // ── 4. The rule text really changed (ac-1) ──
  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/standards/${standard.handle}`),
  );
  await expect(page.getByText(proposed)).toBeVisible({ timeout: 15_000 });
  // And the clause the proposal did NOT touch is untouched — "without any untouched
  // clause being rewritten in the process" is part of ac-1's claim, and it is what the
  // clause grain buys over the section rewrite this replaced.
  await expect(page.getByText("Invalidate on delete.")).toBeVisible();
  await expect(page.getByText("Cache every write.", { exact: true })).toHaveCount(0);
});
