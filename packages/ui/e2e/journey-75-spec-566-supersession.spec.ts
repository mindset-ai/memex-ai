import { test, expect, tenantPath } from "./helpers/index.js";
import { seedAc, seedTestEvent } from "./helpers/seed.js";
import {
  seedAcProposal,
  seedOpenDecision,
  seedOrgTenant,
  seedSpec,
  setDocStatus,
} from "./helpers/retained.js";

// Journey 75 (spec-566 t-11) — the flow a person now meets: a pending supersession
// they can review, a Spec that refuses to close over it, and an override that signs
// its name.
//
// ── WHAT THIS JOURNEY DOES NOT DO, AND WHY ──
//
// t-11's description opens with "a verified criterion is edited → the edit is
// refused". Read against the code, that is not a browser flow: `packages/ui/src/api/acs.ts`
// exposes `acceptAc` and `unacceptAc` and nothing else — editing a criterion's
// statement is `update_ac`, which is MCP-only, and there is no web control for it.
// Driving it here would mean inventing a control the product does not have, which is
// the opposite of what a journey is for.
//
// So the refusal is asserted where it actually happens, in
// `services/ac-update-guards.integration.test.ts` (ac-23, ac-24, ac-26), and this
// journey covers what a PERSON actually does in the browser. That split is stated
// rather than quietly narrowed: std-28 asks for a journey over the user-facing flow
// change, and the user-facing changes spec-566 made are the counts, the /drift row,
// the gate refusal on the board and the override dialog.
//
// Seeded through the env-gated test surface, never raw SQL [per std-28]; navigation is
// path-based [per std-2].

const ORIGINAL = "The exporter writes one row per invoice.";
const REPLACEMENT = "The exporter writes one row per invoice LINE ITEM.";

test("a pending supersession is reviewable in /drift, and the Spec will not close over it", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j75");
  const tenant = await seedOrgTenant({ slug });

  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "The exporter reconciles to the ledger",
  });

  // A criterion that is GREEN. Both halves matter: the criterion has to be one a
  // reader would treat as settled, or "this Spec cannot close" reads as ordinary
  // incompleteness rather than as the gate doing its job.
  const ac = await seedAc({
    memexId: tenant.memexId,
    docId: spec.docId,
    kind: "implementation",
    statement: ORIGINAL,
  });
  await seedTestEvent({
    subjectRef: ac.subjectRef!,
    status: "pass",
    testIdentifier: "packages/server/src/exporter.test.ts::reconciles",
  });

  const decision = await seedOpenDecision({
    memexId: tenant.memexId,
    docId: spec.docId,
    title: "Billing moved to line-item granularity",
    // Two options minimum — the seed schema enforces it, and a "decision" with a
    // single answer is narrative rather than a decision anyway.
    options: [{ label: "Per line item" }, { label: "Keep per invoice" }],
  });

  await seedAcProposal({
    memexId: tenant.memexId,
    acId: ac.acId,
    decisionId: decision.decisionId,
    proposedStatement: REPLACEMENT,
    rationale: "the old wording is now false",
  });

  // ── 1. The criterion's statement is UNCHANGED by the proposal (ac-1, ac-7) ──
  //
  // Into `verify`, which is where the gate arc needs it anyway. The AC panel
  // lives under the Decisions & ACs sub-tab, which a non-draft Spec lands on.
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "verify" });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" },
  );
  const acPanel = page.getByTestId("ac-panel");
  await expect(acPanel).toBeVisible({ timeout: 15_000 });
  // Byte-for-byte what was authored. A proposal that had already rewritten it
  // would make the human accept decorative.
  await expect(acPanel).toContainText(ORIGINAL);
  await expect(acPanel).not.toContainText(REPLACEMENT);

  // ── 2. The proposal is reviewable in the Drift Inbox, with BOTH statements (ac-10) ──
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/drift"));
  const row = page.getByTestId("drift-inbox-row").first();
  await expect(row).toBeVisible();
  // It names the CRITERION, not just the Spec.
  await expect(page.getByTestId("drift-ac-handle")).toHaveText(`ac-${ac.seq}`);

  // Collapsed to start — spec-498 took the wall of text out of this list, and a
  // supersession must not put it back.
  await expect(page.getByTestId("drift-ac-supersession-diff")).toHaveCount(0);
  await page.getByTestId("drift-ac-supersession-toggle").click();
  await expect(page.getByTestId("drift-ac-before")).toContainText(ORIGINAL);
  await expect(page.getByTestId("drift-ac-after")).toContainText(REPLACEMENT);

  // The page no longer claims to be Standards-only.
  await expect(page.getByText(/acceptance criteria/i).first()).toBeVisible();

  // NO Accept control — spec-143 dec-3, and dec-1's retry-resistance rests on it:
  // the human accepts by talking to the agent, behind render_confirmation.
  await expect(row.getByRole("button", { name: /^accept$/i })).toHaveCount(0);
  await expect(row.getByRole("button", { name: /^reject$/i })).toHaveCount(0);
  // The handoff is what the row offers instead.
  await expect(page.getByTestId("drift-discuss-button").first()).toBeVisible();

  // ── 3 & 4. The gate refuses; the override clears it, on the record (ac-20, ac-21) ──
  //
  // HOW THESE ARE DRIVEN, and why not by clicking.
  //
  // The kanban drag is the interaction dec-10 chose the seam for, and its handling
  // of the typed refusal is asserted by mounting the hook
  // (`useSpecBoard.gate.spec-566.test.tsx`, ac-29) — a headless drag-and-drop is
  // the least reliable thing in Playwright and would buy a flaky test, not a
  // stronger claim. The Spec page's own Done tab is a browse PREVIEW here, not an
  // advance, so there is no control on it to click either (see spec-566 issue-3).
  //
  // So the acts run through the API with the PAGE'S OWN credentials, and every
  // consequence a person would see is asserted on a rendered page below. The
  // token matters: `page.request` does not attach it, and an unauthenticated call
  // 404s [per std-7] before it ever reaches the gate — which is exactly how the
  // first draft of this journey "passed" a 404 off as a refusal.
  const api = async (path: string, body: unknown) =>
    page.evaluate(
      async ([p, b]) => {
        const token = window.localStorage.getItem("memex-auth-token");
        const res = await fetch(p as string, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(b),
        });
        return { ok: res.ok, status: res.status, body: await res.text() };
      },
      [path, body] as [string, unknown],
    );

  const base = `/api/${tenant.namespaceSlug}/${tenant.memexSlug}/docs/${spec.docId}`;

  const refused = await api(`${base}/status`, { status: "done" });
  expect(refused.status).toBe(409);
  // The typed discriminator is what lets the board open the override instead of
  // rolling the card back in silence (ac-29) — the behaviour whose absence got
  // spec-391's block reverted.
  expect(refused.body).toContain("DONE_GATE_BLOCKED");
  // The refusal states the outcome: which criterion, and the calls that clear it.
  expect(refused.body).toContain(`ac-${ac.seq}`);
  expect(refused.body).toContain("override_done_gate");

  // The claim is not "it was refused" — it is that the Spec DID NOT CLOSE, read
  // back from the page. A gate that warns and lets the close through satisfies
  // every assertion above.
  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`),
    { waitUntil: "commit" },
  );
  await expect(
    page.locator('[role="tab"][data-tab="verify"][data-current="true"]'),
  ).toBeVisible({ timeout: 15_000 });

  // An override with no stated reason is refused — the quiet path dec-7's count
  // exists to close.
  const noReason = await api(`${base}/done-gate-override`, { reason: "   " });
  expect(noReason.ok).toBe(false);

  const overridden = await api(`${base}/done-gate-override`, {
    reason: "the proposal is stale; the criterion is retired next sprint",
  });
  expect(overridden.ok).toBe(true);

  // The count is the whole anti-decay device: an override nobody can see becomes
  // the normal path. Asserted on a RENDERED surface, never on an API response —
  // and asserted HERE, before the close, because the board collapses its Done
  // column by default (spec-10 dec-5), so a closed Spec's card is not on screen
  // to carry the count. That ordering is the honest one anyway: an override is
  // visible the moment it is made, not once the Spec finally closes.
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
  await expect(page.getByText(/1 gate override/i).first()).toBeVisible({ timeout: 15_000 });

  // …and with the gate clear, the Spec closes.
  const closed = await api(`${base}/status`, { status: "done" });
  expect(closed.ok).toBe(true);
});

test("reopening the closed Spec asks for a reason, and the reopen is counted", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j75r");
  const tenant = await seedOrgTenant({ slug });
  const spec = await seedSpec({ memexId: tenant.memexId, title: "A closed Spec" });
  await seedAc({
    memexId: tenant.memexId,
    docId: spec.docId,
    kind: "implementation",
    statement: "A claim this Spec certified.",
  });
  await setDocStatus({ memexId: tenant.memexId, docId: spec.docId, status: "done" });

  // ── The Done screen's Reopen affordance now collects WHY (ac-27) ──
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`));
  await page.getByTestId("done-reopen").click();

  const confirm = page.getByTestId("done-reopen-confirm");
  await expect(confirm).toBeVisible();
  // Refused until there is a reason. dec-9 froze a closed Spec's criteria and
  // named reopening as the way back in; free and silent, reopening is simply the
  // route around that freeze.
  await expect(page.getByTestId("done-reopen-yes")).toBeDisabled();

  await page
    .getByTestId("done-reopen-reason")
    .fill("the ledger criterion certified the wrong version");
  await expect(page.getByTestId("done-reopen-yes")).toBeEnabled();
  await page.getByTestId("done-reopen-yes").click();

  // The Spec really reopened — read from the page, not from the click.
  await expect(page.getByTestId("done-summary")).toHaveCount(0);

  // …and the reopen is counted beside coverage, on the same terms as the other two.
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
  await expect(page.getByText(/1 reopen/i).first()).toBeVisible();
});
