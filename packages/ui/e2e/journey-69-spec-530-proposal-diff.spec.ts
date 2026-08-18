import { test, expect, tenantPath } from "./helpers/index.js";
import {
  seedOrgTenant,
  seedStandard,
  seedClauses,
  seedProposal,
} from "./helpers/retained.js";

// Journey 69 (spec-530 t-7): a proposal's before/after is READABLE in the Drift Inbox.
//
// The flow this covers used to dead-end. A proposal row was one line — "Proposes a
// change to std-N …" — and the proposed text, though fetched to the client, was rendered
// by no component. The file's own header claimed the diff was "reachable via Discuss
// with Agent or the standard page"; it was reachable via neither. A user asked to judge
// a proposal had no way to see what it said, which is half of what spec-530 ac-2 forbids
// (the other half, the agent's truncated copy, is covered by ac-22's unit tests).
//
// Deliberately does NOT drive the accept. `accept_standard_change` is spec-530 t-4 and
// is not on this branch; extending this journey to seed → read → accept → watch the row
// clear is t-10, once that verb has merged. Asserting a read-only flow here rather than
// pretending to cover the whole loop keeps the journey honest about what ships.
//
// Seeded through the env-gated test surface, never raw SQL [per std-28]; navigation is
// path-based [per std-2].

test("a proposal in the Drift Inbox reveals current vs proposed, per clause", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j69");
  const tenant = await seedOrgTenant({ slug });

  const standard = await seedStandard({
    memexId: tenant.memexId,
    title: "Caching Standard",
    body: "",
  });
  const { clauseIds } = await seedClauses({
    memexId: tenant.memexId,
    sectionId: standard.sectionId,
    clauses: [
      "Cache every write.",
      "Invalidate on delete.",
    ],
  });

  // One proposal, two operations — an edit and an add — so the row exercises the SET
  // shape dec-1 settled on, not just a single-clause change.
  await seedProposal({
    memexId: tenant.memexId,
    operations: [
      {
        op: "edit",
        clauseId: clauseIds[0],
        body: "Cache every write except mutating endpoints.",
      },
      {
        op: "add",
        clauseId: clauseIds[1],
        placement: "after",
        body: "Never cache a response carrying a Set-Cookie header.",
      },
    ],
    rationale: "The rule is too broad and is missing a case.",
  });

  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/drift"));

  const row = page.getByTestId("drift-inbox-row").first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-row-type", "proposal");

  // Collapsed on arrival — spec-498 took the wall of text out of this list deliberately,
  // and a proposal is now a SET, so an expanded default would put N blocks in a list.
  await expect(page.getByTestId("drift-proposal-diff")).toHaveCount(0);

  const toggle = row.getByTestId("drift-proposal-toggle");
  await expect(toggle).toHaveText(/2 clause changes/);
  await toggle.click();

  const operations = page.getByTestId("drift-proposal-operation");
  await expect(operations).toHaveCount(2);

  // The edit: what the rule says now, and what the proposal wants it to say. This is
  // the text a user could not see before.
  const edit = operations.nth(0);
  await expect(edit).toHaveAttribute("data-op", "edit");
  await expect(edit.getByTestId("drift-proposal-current")).toContainText("Cache every write.");
  await expect(edit.getByTestId("drift-proposal-proposed")).toContainText(
    "Cache every write except mutating endpoints.",
  );
  // Named by its canonical handle [per std-10] — the same identifier the agent acts on.
  await expect(edit.getByTestId("drift-proposal-clause")).toHaveText(/^cl-\d+$/);

  // The add: a clause the rule does not have yet, anchored to one it does.
  const add = operations.nth(1);
  await expect(add).toHaveAttribute("data-op", "add");
  await expect(add).toContainText("Never cache a response carrying a Set-Cookie header.");

  // Read-only [per spec-143 dec-3, restated in spec-530's non-goals]: reading the diff
  // must not put an Accept control on screen. Acceptance is a conversation.
  await expect(page.getByRole("button", { name: /^accept/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^reject/i })).toHaveCount(0);

  // And it collapses again, so a reader who opened the wrong row can put it back.
  await toggle.click();
  await expect(page.getByTestId("drift-proposal-operation")).toHaveCount(0);
});
