import {
  test,
  expect,
  tenantPath,
  switchToEditing,
  emitAcEvents,
} from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  setDocStatus,
  seedOpenDecision,
  seedComment,
} from "./helpers/retained.js";

// Journey 33 — spec-259 ac-5: the web Specify phase surfaces open-comment
// status CONSISTENTLY with the MCP agent's view, and the specify→build Rubicon
// sentence is comments-aware ADVISORY guidance (the web does NOT hard-gate —
// spec-247 / std-34: the web is for viewing + minimum-friction input).
//
//   • The Comments sub-tab shows the same open-comment picture the agent sees:
//     counts, anchor-kind split (decision-anchored vs section-anchored, where
//     tasks fold into section-anchored), and the oldest open comment's relative
//     age — all via the SHARED timeAgo so the phrasing matches.
//   • Every comment row carries a WHO/WHEN byline (author + relative time).
//   • The Rubicon sentence reads the exact spec-259 copy and the advance-to-Build
//     affordance stays reachable WITH open comments present (guidance, not lock).
//
// ac-5 has the component-level AllComments tests as its unit proof; this journey
// is the end-to-end proof that the seeded open comments actually render this
// picture in the running app.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-259/acs/ac-${n}`;
const ACS = [AC(5)];

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-33-spec-259-open-comment-parity.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("specify Comments surface shows the open-comment summary + WHO/WHEN byline; advance-to-Build stays reachable", async ({
  page,
  resources,
}) => {
  const tenant = await seedOrgTenant({ slug: resources.slug("j33") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Open Comment Parity Spec",
    purpose: "Exercise the Specify-phase open-comment parity surface.",
  });
  await setDocStatus({
    memexId: tenant.memexId,
    docId: spec.docId,
    status: "specify",
  });

  // An open DECISION (so we can hang a decision-anchored comment off it).
  const decision = await seedOpenDecision({
    memexId: tenant.memexId,
    docId: spec.docId,
    title: "Pick the cache layer",
    context: "Two options on the table.",
    options: [
      { label: "Redis", trade_offs: "Battle-tested; another box." },
      { label: "In-process LRU", trade_offs: "Zero-ops; per-instance only." },
    ],
  });

  // One section-anchored open comment (on the overview section) + one
  // decision-anchored open comment → the summary should read 2 open, split 1/1.
  await seedComment({
    memexId: tenant.memexId,
    target: "section",
    targetId: spec.sectionId,
    authorName: "Sam Section",
    content: "This section needs another pass before we build.",
  });
  await seedComment({
    memexId: tenant.memexId,
    target: "decision",
    targetId: decision.decisionId,
    authorName: "Dana Decision",
    content: "Have we considered the cold-start cost of Redis?",
  });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" },
  );
  await expect(
    page.getByRole("heading", { level: 1, name: /Open Comment Parity Spec/ }),
  ).toBeVisible({ timeout: 15_000 });

  // ── The Rubicon is ADDITIVE (spec-259 ac-5 reconciled with spec-282/196) ──
  // This spec has an OPEN decision, so the current-tab Rubicon leads with the
  // spec-282 blocker statement (NOT a lock — status only, no button). The
  // comments-aware advisory ("You can advance to Build when all open decisions
  // are resolved and all comments are addressed.") is the CLEAN-state form, pinned
  // in the TransitionSentence unit tests. Here we assert the blocker coexists with
  // the open-comment surface below.
  await expect(page.getByTestId("transition-sentence")).toContainText(
    /Decision.*must be resolved/i,
    { timeout: 15_000 },
  );
  await expect(page.getByRole("button", { name: "Yes" })).toHaveCount(0);

  // ── Open the Comments sub-tab ──
  await page.getByRole("button", { name: /^Comments\b/ }).click();

  // ── The open-comment summary mirrors the agent's picture ──
  const summary = page.getByTestId("open-comments-summary");
  await expect(summary).toBeVisible({ timeout: 15_000 });
  await expect(summary).toContainText("2 open comments");
  await expect(summary).toContainText("1 decision-anchored");
  await expect(summary).toContainText("1 section-anchored");
  // Oldest age is a relative phrase from the shared timeAgo helper (freshly-seeded
  // comments render "just now"; older ones "Nd ago").
  await expect(page.getByTestId("open-comments-oldest")).toContainText(/just now|ago/);

  // ── Every comment row carries a WHO + WHEN byline ──
  await expect(
    page.getByTestId("comment-byline-author").first(),
  ).toBeVisible();
  await expect(page.getByText("Sam Section")).toBeVisible();
  await expect(page.getByText("Dana Decision")).toBeVisible();
  // WHEN is a relative phrase (matching the agent), not an absolute date.
  await expect(page.getByTestId("comment-byline-when").first()).toContainText(
    /just now|ago/,
  );

  // ── No hard gate: advancing to Build stays reachable WITH open comments ──
  // The web doesn't move the phase from the current tab (spec-282) — the move
  // lives on the browse-forward Build-tab confirm. An editor browsing the Build
  // tab still gets a working "Move this spec anyway? [Yes]" even though open
  // comments + decisions remain: the Rubicon is guidance, never a lock.
  await switchToEditing(page);
  await page.locator('[role="tab"][data-tab="build"]').click();
  const sentence = page.getByTestId("transition-sentence");
  await expect(sentence).toBeVisible({ timeout: 15_000 });
  await expect(
    sentence.getByRole("button", { name: "Yes" }),
  ).toBeEnabled();
});
