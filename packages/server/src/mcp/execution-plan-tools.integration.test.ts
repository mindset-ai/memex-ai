// Integration tests for the t-7 Execution Plan MCP tools (doc-10 Slice 2). Real DB.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  decisions,
  tasks,
  docComments,
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { createDocDraft } from "../services/documents.js";
import { createTask } from "../services/tasks.js";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (created.docs.length) {
    await db
      .delete(docComments)
      .where(inArray(docComments.memexId, created.memexes))
      .catch(() => {});
    await db
      .delete(tasks)
      .where(inArray(tasks.docId, created.docs))
      .catch(() => {});
    await db
      .delete(decisions)
      .where(inArray(decisions.docId, created.docs))
      .catch(() => {});
    await db
      .delete(documents)
      .where(inArray(documents.id, created.docs))
      .catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
});

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `mcp-plan-${sub}@memex.ai` } as any)
    .returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, account: a };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

async function callTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (
    server as unknown as { _registeredTools: Record<string, RegisteredToolLike> }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  // Per dec-1 of doc-20 the MCP surface defaults to terse output. Pre-doc-20
  // tests assert against the verbose markdown surface, so opt in via the
  // documented `verbose: true` escape hatch unless the test sets it.
  const withVerbose = "verbose" in args ? args : { ...args, verbose: true };
  return await tool.handler(withVerbose, {} as unknown);
}

let actor: Awaited<ReturnType<typeof setupActor>>;

beforeAll(async () => {
  actor = await setupActor("plan");
});

// SKIP: doc-24 — execution_plan path on create_doc / list_docs removed from MCP surface; restore alongside the docType param.
describe.skip("Execution Plan MCP tools (post-doc-14)", () => {
  it("registers the consolidated execution-plan-related tools", () => {
    const server = createMcpServer(actor.user.id);
    const names = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    // Post doc-14: submission folds into create_doc, retrieval into list_docs / get_doc.
    expect(names).toContain("create_doc");
    expect(names).toContain("list_docs");
    expect(names).toContain("get_doc");
  });

  it("submit_execution_plan creates a plan, links task, and posts readiness comment (via create_doc)", async () => {
    const spec = await createDocDraft(actor.account.id, "Plan Spec", "P", "spec");
    created.docs.push(spec.id);
    const item = await createTask(actor.account.id, spec.id, "Build feature X", "Desc");

    const result = await callTool(actor.user.id, "create_doc", {
      docType: "execution_plan",
      linkedTaskId: item.id,
      title: "Plan for feature X",
      sections: {
        files_modified: "src/feature-x.ts (new)",
        narrative: "Plan walkthrough",
      },
      readinessAssessment: "READY — all decisions resolved",
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // Post doc-14 the create_doc(execution_plan) branch returns a one-line ack
    // ("Execution plan created: <handle> <title> linked to task t-N"). Side-effects
    // below are the load-bearing assertions; we just check the ack mentions the task.
    expect(text).toMatch(/Execution plan created/);
    expect(text).toContain(`t-${item.seq}`);

    // Plan doc was created with docType=execution_plan and linked
    const reload = await db.query.tasks.findFirst({ where: eq(tasks.id, item.id) });
    expect(reload!.executionPlanDocId).toBeTruthy();
    if (reload!.executionPlanDocId) created.docs.push(reload!.executionPlanDocId);

    // Readiness comment was posted on the task with type=readiness_check, source=agent
    const comments = await db.query.docComments.findMany({
      where: eq(docComments.taskId, item.id),
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].commentType).toBe("readiness_check");
    expect(comments[0].source).toBe("agent");
    expect(comments[0].content).toContain("READY");
  });

  it("submit_execution_plan rejects a second plan on the same task (via create_doc)", async () => {
    const spec = await createDocDraft(actor.account.id, "Plan Spec 2", "P", "spec");
    created.docs.push(spec.id);
    const item = await createTask(actor.account.id, spec.id, "Build Y", "Desc");

    const first = await callTool(actor.user.id, "create_doc", {
      docType: "execution_plan",
      linkedTaskId: item.id,
      title: "Plan Y",
    });
    expect(first.isError).toBeFalsy();
    const planDoc = await db.query.tasks.findFirst({ where: eq(tasks.id, item.id) });
    if (planDoc?.executionPlanDocId) created.docs.push(planDoc.executionPlanDocId);

    const second = await callTool(actor.user.id, "create_doc", {
      docType: "execution_plan",
      linkedTaskId: item.id,
      title: "Plan Y again",
    });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/already has an execution plan/);
  });

  it("get_execution_plan returns null-style message when no plan linked (via list_docs)", async () => {
    const spec = await createDocDraft(actor.account.id, "PlanlessSpec", "P", "spec");
    created.docs.push(spec.id);
    const item = await createTask(actor.account.id, spec.id, "Unplanned", "Desc");
    const result = await callTool(actor.user.id, "list_docs", {
      docType: "execution_plan",
      linkedTaskId: item.id,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/No execution plan linked/);
  });

  it("get_execution_plan returns the linked plan (via list_docs)", async () => {
    const spec = await createDocDraft(actor.account.id, "PlanFetchSpec", "P", "spec");
    created.docs.push(spec.id);
    const item = await createTask(actor.account.id, spec.id, "Fetch me", "Desc");
    await callTool(actor.user.id, "create_doc", {
      docType: "execution_plan",
      linkedTaskId: item.id,
      title: "Fetch me plan",
      sections: { conflicts: "None known." },
    });
    const reload = await db.query.tasks.findFirst({ where: eq(tasks.id, item.id) });
    if (reload?.executionPlanDocId) created.docs.push(reload.executionPlanDocId);

    const result = await callTool(actor.user.id, "list_docs", {
      docType: "execution_plan",
      linkedTaskId: item.id,
    });
    expect(result.isError).toBeFalsy();
    // list_docs(execution_plan, linkedTaskId) returns the plan handle + title in the
    // ack line. The full plan body (sections like "None known.") is read via get_doc.
    expect(result.content[0].text).toMatch(/execution_plan/);
  });

  // get_dependents was dropped in doc-14: the parent Spec's get_doc output
  // already lists every task with its execution_plan link. Coverage of "lists
  // every plan dependent on a spec" is implicit in the get_doc contract.
});
