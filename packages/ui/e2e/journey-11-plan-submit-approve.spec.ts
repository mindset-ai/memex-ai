import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedExecutionPlan, getDocStatus } from "./helpers/retained.js";

// Journey 11 (t-19 W5): execution-plan submit → approve → plan status flips to
// approved (covers t-17, dec-26).
//
// Two pieces of the product are tested end-to-end here:
//
//   1. **Submit side** — `submit_execution_plan` is an MCP-only tool (it lives
//      on `/mcp`, not on the in-app agent's server-tool registry). The coding
//      agent that authors the plan is Claude Code over MCP, not the in-Memex
//      chat agent — that asymmetry is intentional. So we don't drive submit
//      through the chat panel; we seed the task + plan + READY readiness comment
//      through the server's real services (seedExecutionPlan), mirroring the
//      state submit_execution_plan would leave the DB in. (Re-based off raw SQL
//      per dec-2 — the seed now emits on the bus [per std-8].)
//
//   2. **Approve side** — TaskPanel renders a `Plan: READY` trigger
//      (data-testid="plan-trigger") for any task with a linked execution plan;
//      the trigger opens `ExecutionPlanModal`, where Approve
//      (data-testid="plan-approve") flips the plan doc's status to 'approved'.

test("user opens plan from task panel, approves, plan status flips to approved", async ({
  page,
  resources,
}) => {
  const slug = resources.slug("j11");
  const tenant = await seedOrgTenant({ slug });
  const { docId } = await seedSpec({
    memexId: tenant.memexId,
    title: "Plan Approve Spec",
    purpose: "We need a plan first.",
  });

  // Seed the post-submit_execution_plan state: a task + a linked execution plan +
  // a READY readiness comment (so derivePlanBadgeState renders "Plan: READY").
  const { planDocId } = await seedExecutionPlan({
    memexId: tenant.memexId,
    docId,
    taskTitle: "Implement auth",
  });

  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`));
  await expect(page.getByText(/We need a plan first/)).toBeVisible({ timeout: 15_000 });

  // Tasks live under the Build phase. spec-282: the Build view now lands on the
  // Decisions & ACs sub-tab, so after the Build phase tab click open the unified
  // "Agent Tasks & Issues" sub-tab to surface the TaskPanel.
  await page.getByRole("tab", { name: "Build" }).click();
  await page.getByRole("button", { name: /Agent Tasks & Issues/ }).click();

  // The plan trigger is rendered by TaskPanel for any task with an
  // executionPlanDocId. With a 'READY — all green' readiness comment its label
  // reads 'Plan: READY'.
  await page.getByTestId("plan-trigger").first().click({ timeout: 15_000 });

  // Approve in the modal. Per t-17 / t-20 W-B the Approve button has
  // data-testid="plan-approve" and flips plan.status to 'approved'.
  await page.getByTestId("plan-approve").click({ timeout: 15_000 });

  // Poll the plan doc's status through the test-only read surface (no raw SQL,
  // dec-2) until it flips to approved (or the 'done' legacy alias).
  await expect
    .poll(async () => getDocStatus(planDocId), { timeout: 15_000 })
    .toMatch(/^(approved|done)$/);
});
