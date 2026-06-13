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
} from "./helpers/retained.js";

// The ACs this end-to-end journey genuinely exercises against the running app.
// Behaviour units (DecisionPanel/ChatPanel) also cover ac-6/7/9/11/12; the
// reload-survival path (ac-18, ac-22) and the scope-level "one obvious place /
// honest labels / grounded panel" outcomes (ac-1, ac-2, ac-3) have NO other
// verifying test — this journey is their only proof, so it must emit.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-247/acs/ac-${n}`;
const ACS = [1, 2, 3, 6, 7, 9, 11, 12, 18, 22].map(AC);

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-27-spec-247-decision-surfaces.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

// Journey 27 — spec-247: resolving a decision has ONE obvious place to answer.
//
//   • The open-decision card carries NO CTA button and NO inline comment box —
//     the option rows are the only answering affordance (ac-6, ac-9).
//   • Clicking an option records the answer immediately and it SURVIVES a full
//     page reload — the prod failure (answers silently dropped on navigation)
//     is unreproducible (ac-7, ac-18, ac-22).
//   • Re-selecting a different option on the resolved card updates the choice
//     in place (ac-7).
//   • Discussion sits behind a labelled toggle that says it never resolves
//     anything (ac-9).
//   • The left panel introduces itself as the Spec assistant and discloses
//     its grounding without any interaction (ac-11, ac-12).

test("answer-by-click persists across reload, re-select updates, discussion is toggled, assistant discloses grounding", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j27");
  const tenant = await seedOrgTenant({ slug });
  const seeded = await seedSpec({
    memexId: tenant.memexId,
    title: "Decision Surface Spec",
    purpose: "Exercise the one-obvious-place-to-answer surface.",
  });
  await setDocStatus({ memexId: tenant.memexId, docId: seeded.docId, status: "specify" });
  await seedOpenDecision({
    memexId: tenant.memexId,
    docId: seeded.docId,
    title: "Pick the cache layer",
    context: "Two options on the table.",
    options: [
      { label: "Redis", trade_offs: "Battle-tested; another box." },
      { label: "In-process LRU", trade_offs: "Zero-ops; per-instance only." },
    ],
  });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${seeded.handle}`)
  );

  // ── The assistant names itself and discloses grounding (ac-11 / ac-12) ──
  await expect(page.getByText("Spec assistant")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Private Agent")).toHaveCount(0);
  const grounding = page.getByTestId("chat-grounding-line");
  await expect(grounding).toBeVisible();
  await expect(grounding).toContainText(/Hasn't read your code/);
  await expect(
    grounding.getByRole("link", { name: /connect a coding agent/i })
  ).toBeVisible();

  await switchToEditing(page);

  // ── The decision card: options only, no CTA, no inline comment box ──
  await page.getByRole("button", { name: /Decisions & ACs/ }).click();
  const panel = page.getByTestId("decision-panel");
  await expect(panel).toContainText(/Pick the cache layer/, { timeout: 15_000 });

  await expect(panel.getByTestId("decision-resolve")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^Resolve$/ })).toHaveCount(0);
  await expect(panel.getByTestId("comment-textarea")).toHaveCount(0);
  await expect(panel.getByTestId("persist-on-select-hint")).toContainText(
    /records your answer/i
  );

  // Discussion is reachable but collapsed, and labelled as never resolving.
  await panel.getByTestId("decision-discussion-toggle").first().click();
  await expect(panel.getByTestId("discussion-disclaimer")).toContainText(
    /never resolve/i
  );
  await panel.getByRole("button", { name: /Hide discussion/ }).click();

  // ── Answer by clicking an option — that IS the resolution ──
  // spec-247 dec-7: no tabs — the decision becomes a resolved card in place.
  await panel.getByTestId("open-option-1").first().check();
  await expect(
    panel.locator('[data-decision-status="resolved"]').first(),
  ).toBeVisible({ timeout: 15_000 });

  // ── The answer survives a full reload (the agent-craft prod scenario) ──
  await page.reload();
  await page.getByRole("button", { name: /Decisions & ACs/ }).click();
  const panelAfter = page.getByTestId("decision-panel");
  await expect(
    panelAfter.locator('[data-decision-status="resolved"]').first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(panelAfter).toContainText(/Chose:/, { timeout: 15_000 });
  await expect(panelAfter).toContainText(/In-process LRU/);

  // ── Re-select: a different option click updates the recorded choice ──
  await panelAfter.getByText("Context", { exact: true }).first().click();
  await panelAfter.getByTestId("resolved-option-0").first().check();
  await expect(panelAfter.getByText(/Chose:/).locator("..")).toContainText("Redis", {
    timeout: 15_000,
  });
});
