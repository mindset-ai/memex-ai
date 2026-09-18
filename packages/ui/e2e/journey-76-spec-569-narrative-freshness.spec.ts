import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedAc } from "./helpers/seed.js";
import {
  acceptAcSupersession,
  consolidateNarrative,
  seedAcProposal,
  seedOpenDecision,
  seedOrgTenant,
  seedSpec,
  setDocStatus,
} from "./helpers/retained.js";

// Journey 76 (spec-569 t-6) — the incident, and the quiet that has to survive it.
//
// spec-524's criteria were superseded and its Overview went false in every
// clause. Nothing flagged it; worse, `assess_spec({mode:'consolidate'})` had
// already certified the narrative as current. A human caught it by reading.
//
// Two arms, and the second is the one that matters:
//
//   1. A superseded criterion LIGHTS the affordance — in `build`, which is
//      where spec-524 actually was. Before dec-2 (b) the page showed this
//      nothing at all: the human signal was gated to `specify` with decisions
//      present and resolved.
//
//   2. Marking a criterion verified by hand leaves it DARK. This is the arm
//      that proves the signal is still worth reading. Without it the journey
//      only proves a badge can turn on, and a badge that is always on is one
//      people learn to ignore — which dec-1 judged strictly worse than the
//      honest silence we started from.
//
// ── A NOTE ON THE SEEDING, SO IT IS NOT MISTAKEN FOR A SHORTCUT ──
//
// Arm 1 accepts the supersession through the env-gated test surface rather than
// through the browser, because there is no browser flow to drive: supersession
// is recorded exclusively through the MCP tool (`packages/ui/src/api/types.ts`).
// The endpoint calls the real `acceptAcSupersession` service. Writing
// `status: 'superseded'` onto the row directly would have been easier and
// wrong — `acs.updatedAt` is stamped inside `supersedeAcTx`, and that timestamp
// is the entire input this Spec turns on. A fixture that skipped it would have
// tested nothing.
//
// Seeded through the env-gated test surface, never raw SQL [per std-28];
// navigation is path-based [per std-2].

// Title→refs map, per the repo's e2e emission idiom (journey-18 / journey-20).
// Routing is namespace-derived; gated by MEMEX_EMIT.
const SPEC569 = "mindset-prod/memex-building-itself/specs/spec-569";
const ACS_BY_TEST: Record<string, string[]> = {
  "a superseded criterion tells the reader the prose may be stale — in build, where it actually happened":
    [`${SPEC569}/acs/ac-1`, `${SPEC569}/acs/ac-2`],
  "marking a criterion verified by hand leaves the narrative signal dark": [
    `${SPEC569}/acs/ac-3`,
  ],
};
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const refs = ACS_BY_TEST[testInfo.title];
  if (!refs) return;
  await emitAcEvents(
    refs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-76-spec-569-narrative-freshness.spec.ts::${testInfo.title}`,
    testInfo.duration ?? 0,
  );
});

const ORIGINAL = "The exporter writes one row per invoice.";
const REPLACEMENT = "The exporter writes one row per invoice LINE ITEM.";

test("a superseded criterion tells the reader the prose may be stale — in build, where it actually happened", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j76a");
  const tenant = await seedOrgTenant({ slug });

  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "The exporter reconciles to the ledger",
  });
  const ac = await seedAc({
    memexId: tenant.memexId,
    docId: spec.docId,
    kind: "implementation",
    statement: ORIGINAL,
  });
  const decision = await seedOpenDecision({
    memexId: tenant.memexId,
    docId: spec.docId,
    title: "Billing moved to line-item granularity",
    options: [{ label: "Per line item" }, { label: "Keep per invoice" }],
  });

  // The narrative is declared current FIRST. Without this anchor every row on
  // the Spec reads as "never captured" and the affordance would light for
  // reasons that have nothing to do with the criterion.
  await consolidateNarrative({ memexId: tenant.memexId, docId: spec.docId });

  // `build`, deliberately: this is the phase spec-524 was in, and the phase the
  // pre-dec-2 gating stayed silent through.
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "build" });

  const proposed = await seedAcProposal({
    memexId: tenant.memexId,
    acId: ac.acId,
    decisionId: decision.decisionId,
    proposedStatement: REPLACEMENT,
    rationale: "the old wording is now false",
  });
  await acceptAcSupersession({
    memexId: tenant.memexId,
    commentId: proposed.commentId,
  });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" },
  );

  const sentence = page.getByTestId("transition-sentence");
  await expect(sentence).toContainText("The spec narrative");
  await expect(sentence).toContainText("changed meaning");

  // It names the criterion, not decisions — the number behind it counts
  // criteria, so the sentence may not say "decisions" (ac-4).
  await expect(sentence).not.toContainText("resolved decisions");
});

test("marking a criterion verified by hand leaves the narrative signal dark", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j76b");
  const tenant = await seedOrgTenant({ slug });

  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "The exporter reconciles to the ledger",
  });
  await seedAc({
    memexId: tenant.memexId,
    docId: spec.docId,
    kind: "implementation",
    statement: ORIGINAL,
  });

  await consolidateNarrative({ memexId: tenant.memexId, docId: spec.docId });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "verify" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" },
  );

  // Precondition: the affordance is dark BEFORE the click. Without this the
  // assertion afterwards could pass because it was never going to appear in
  // this fixture at all.
  await expect(page.getByTestId("ac-panel")).toBeVisible();
  await expect(page.getByText("changed meaning")).toHaveCount(0);

  // The most ordinary act on this panel. It stamps `acs.updatedAt` — and must
  // move nothing, because the criterion's meaning has not changed (ac-3, ac-6).
  await page.getByRole("button", { name: "Mark as accepted" }).first().click();
  await expect(
    page.getByRole("button", { name: "Un-accept" }).first(),
  ).toBeVisible();

  // RELOAD, and not as belt-and-braces — without it this arm is VACUOUS.
  //
  // The page fetches the Spec's criteria once on mount; the AC panel refreshes
  // its own view after the click, but `DocDocument`'s copy still carries the
  // pre-click `updatedAt`. So the staleness signal is computed from a row that
  // has not moved, and "stays dark" holds for a reason that has nothing to do
  // with the predicate. Caught by mutation: with 'active' added to the
  // meaning-changed set this test still PASSED, which is the definition of a
  // guard that cannot express its claim. The reload makes the assertion read
  // the row the click actually wrote.
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByTestId("ac-panel")).toBeVisible();

  await expect(page.getByText("changed meaning")).toHaveCount(0);
  await expect(page.getByText("not yet reflected in the narrative")).toHaveCount(0);
});
