import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedOpenDecision, seedComment } from "./helpers/retained.js";
import {
  addOrgMember,
  setUserName,
  seedCommentMention,
  setCommentAssignee,
} from "./helpers/seed.js";

// Journey 37 — spec-320: @-mention a colleague in a comment + assign a comment to
// someone. Two real-browser proofs:
//   1. RENDER PATH — a comment seeded (via the env-gated test surface, std-28) with
//      a mention + assignee renders its mention chip + "Assigned to <name>" label in
//      the comment tray. Exercises the spec-315 seam (ac-11) and the render of ac-1/
//      ac-2 in a real browser.
//   2. INTERACTIVE TYPEAHEAD — typing `@` + chars in the composer opens a filterable
//      member dropdown (ac-5); selecting a colleague mentions them (ac-1) and the new
//      comment shows the chip.
//
// Comments are exercised on a DECISION (DecisionPanel mounts CommentTray, whose
// CommentBubble renders the chips). The colleague "Harriet" is a real active org
// member so she's both mentionable and resolvable by the seam.
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-320/acs/ac-${n}`;

const COLLEAGUE_EMAIL = "harriet.spec320@example.com";
const COLLEAGUE_NAME = "Harriet";

async function seedSpecWithOpenDecision(slug: string) {
  const tenant = await seedOrgTenant({ slug });
  await addOrgMember({ orgId: tenant.orgId, email: COLLEAGUE_EMAIL, role: "member" });
  await setUserName(COLLEAGUE_EMAIL, COLLEAGUE_NAME);
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Mentions Spec",
    purpose: "A spec whose decision draws comments.",
  });
  const decision = await seedOpenDecision({
    memexId: tenant.memexId,
    docId: spec.docId,
    title: "Which storage shape do we pick?",
    options: [{ label: "Join table" }, { label: "Columns" }],
  });
  return { tenant, spec, decision };
}

/** Navigate to the spec and reveal the decision's comment tray. */
async function openDecisionComments(page, tenant, specHandle: string) {
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${specHandle}`), {
    waitUntil: "commit",
  });
  await expect(page.getByRole("heading", { level: 1, name: /Mentions Spec/ })).toBeVisible({
    timeout: 15_000,
  });
  const toggle = page.getByTestId("decision-discussion-toggle").first();
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await toggle.click();
  await expect(page.getByTestId("comment-tray").first()).toBeVisible({ timeout: 10_000 });
}

test("a seeded mention + assignment renders its chip and 'Assigned to' label (ac-1, ac-2, ac-11)", async ({
  page,
  resources,
}) => {
  let passed = false;
  try {
    const { tenant, spec, decision } = await seedSpecWithOpenDecision(resources.slug("j37a"));
    const comment = await seedComment({
      memexId: tenant.memexId,
      target: "decision",
      targetId: decision.decisionId,
      authorName: "Dev",
      content: "Worth a second opinion on this one.",
    });
    // Seed through the real services via the env-gated surface (no raw SQL, std-28).
    await seedCommentMention({
      memexId: tenant.memexId,
      commentId: comment.commentId,
      userEmail: COLLEAGUE_EMAIL,
      mentionedByEmail: "dev@memex.ai",
    });
    await setCommentAssignee({
      memexId: tenant.memexId,
      commentId: comment.commentId,
      assigneeEmail: COLLEAGUE_EMAIL,
      assignedByEmail: "dev@memex.ai",
    });

    await openDecisionComments(page, tenant, spec.handle);

    // The assignee label + (assignee being a mention) render off the mention set.
    const assignee = page.getByTestId("comment-assignee").first();
    await expect(assignee).toBeVisible({ timeout: 10_000 });
    await expect(assignee).toContainText(COLLEAGUE_NAME);
    passed = true;
  } finally {
    await emitAcEvents(
      [AC(1), AC(2), AC(11)],
      passed ? "pass" : "fail",
      `packages/ui/e2e/journey-37-spec-320-comment-mentions.spec.ts::render`,
      0,
    );
  }
});

test("typing @ opens the member typeahead; selecting a colleague mentions them (ac-5, ac-1)", async ({
  page,
  resources,
}) => {
  let passed = false;
  try {
    const { tenant, spec } = await seedSpecWithOpenDecision(resources.slug("j37b"));
    await openDecisionComments(page, tenant, spec.handle);

    const textarea = page.getByTestId("comment-textarea").first();
    await textarea.click();
    await textarea.fill("Heads up @Harr");

    // The typeahead opens and offers the active member by substring.
    const option = page.getByTestId("mention-option").filter({ hasText: COLLEAGUE_NAME }).first();
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();

    // The selection becomes a tracked mention chip in the composer.
    await expect(page.getByTestId("mention-chip").filter({ hasText: COLLEAGUE_NAME })).toBeVisible({
      timeout: 5_000,
    });

    await page.getByTestId("comment-submit").first().click();

    // The posted comment renders the mention chip.
    await expect(
      page.getByTestId("comment-mention-chip").filter({ hasText: COLLEAGUE_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
    passed = true;
  } finally {
    await emitAcEvents(
      [AC(5), AC(1)],
      passed ? "pass" : "fail",
      `packages/ui/e2e/journey-37-spec-320-comment-mentions.spec.ts::typeahead`,
      0,
    );
  }
});
