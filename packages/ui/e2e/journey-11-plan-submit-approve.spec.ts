import { test, expect, tenantUrl } from "./helpers/fixtures.js";
import { seedAccount, seedDoc } from "./helpers/db.js";
import postgres from "postgres";

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/memex";

// Journey 11 (t-19 W5): execution-plan submit → approve → plan status flips
// to approved (covers t-17, dec-26).
//
// Two pieces of the product are tested end-to-end here:
//
//   1. **Submit side** — `submit_execution_plan` is an MCP-only tool (it lives
//      on `/mcp`, not on the in-app agent's server-tool registry). The coding
//      agent that authors the plan is Claude Code over MCP, not the in-Memex
//      chat agent — that asymmetry is intentional. So we don't drive submit
//      through the chat panel; we seed the plan + readiness comment directly,
//      mirroring the state submit_execution_plan would leave the DB in.
//
//   2. **Approve side** — TaskPanel renders a `Plan: READY` trigger
//      (data-testid="plan-trigger") for any task with a linked execution plan;
//      the trigger opens `ExecutionPlanModal`, where Approve
//      (data-testid="plan-approve") flips the plan doc's status to 'approved'.

test(
  "user opens plan from task panel, approves, plan status flips to approved",
  async ({ page, resources }) => {
    const subdomain = resources.subdomain("j11");
    const accountId = await seedAccount({ subdomain, name: "Plan Approve Test" });
    resources.accountIds.push(accountId);
    await resources.devAsAdmin(accountId);

    const { docId } = await seedDoc({
      accountId,
      handle: "doc-1",
      title: "Plan Approve Spec",
      purpose: "We need a plan first.",
    });

    // Seed a task + linked execution plan + readiness comment directly. This is
    // the state submit_execution_plan would leave the DB in if a Claude Code
    // session had filed the plan against the task via /mcp.
    const sql = postgres(DATABASE_URL);
    let taskId: string;
    let planDocId: string;
    try {
      const [task] = await sql<{ id: string }[]>`
        INSERT INTO tasks (account_id, doc_id, seq, title, description)
        VALUES (${accountId}, ${docId}, 1, 'Implement auth', 'desc')
        RETURNING id
      `;
      taskId = task.id;

      const [plan] = await sql<{ id: string }[]>`
        INSERT INTO documents (account_id, handle, title, doc_type, status)
        VALUES (${accountId}, 'doc-2', 'Execution plan for Implement auth', 'execution_plan', 'draft')
        RETURNING id
      `;
      planDocId = plan.id;

      await sql`
        INSERT INTO doc_sections (doc_id, section_type, title, content, seq)
        VALUES
          (${planDocId}, 'files_modified', 'Files modified', 'src/auth.ts', 1),
          (${planDocId}, 'dependency_flow', 'Dependency flow', 'auth → session', 2),
          (${planDocId}, 'conflicts', 'Conflicts', 'none', 3),
          (${planDocId}, 'narrative', 'Narrative', 'Wire up scrypt-based auth.', 4)
      `;

      await sql`
        UPDATE tasks SET execution_plan_doc_id = ${planDocId} WHERE id = ${taskId}
      `;

      await sql`
        INSERT INTO doc_comments (account_id, task_id, author_name, content, comment_type, source)
        VALUES (${accountId}, ${taskId}, 'Memex agent', 'READY — all green', 'readiness_check', 'agent')
      `;
    } finally {
      await sql.end();
    }

    await page.goto(tenantUrl(subdomain, `/docs/${docId}`));
    await expect(page.getByText(/We need a plan first/)).toBeVisible({ timeout: 15_000 });

    // Open the Tasks tab. Tabs render as <button>, not the ARIA `tab` role.
    // The accessible name carries the count badge (e.g. "Tasks 1"), so match
    // the prefix and the optional count rather than `/^Tasks$/i`. The outline
    // sidebar also has a "Tasks <n> ready" button — disambiguate with .first().
    await page.getByRole("button", { name: /^Tasks( \d+)?$/i }).first().click();

    // The plan trigger is rendered by TaskPanel for any task with an
    // executionPlanDocId. Its label uses derivePlanBadgeState, so with a
    // 'READY — all green' readiness comment it reads 'Plan: READY'.
    await page.getByTestId("plan-trigger").first().click({ timeout: 15_000 });

    // Approve in the modal. Per t-17 / t-20 W-B, the Approve button has
    // data-testid="plan-approve" and flips plan.status to 'approved'.
    await page.getByTestId("plan-approve").click({ timeout: 15_000 });

    const sql2 = postgres(DATABASE_URL);
    try {
      let approved = false;
      for (let i = 0; i < 30; i++) {
        const rows = await sql2<{ status: string }[]>`
          SELECT status FROM documents WHERE id = ${planDocId}
        `;
        if (rows[0]?.status === "approved" || rows[0]?.status === "done") {
          approved = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(approved).toBe(true);
    } finally {
      await sql2.end();
    }
  },
);
