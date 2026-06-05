// Integration tests for the t-9 Decision extraction MCP tools (doc-10 Slice 3). Real DB.

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
  decisionDeps,
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { createDocDraft } from "../services/documents.js";
import { createTask } from "../services/tasks.js";
import { proposeDecision, setDecisionOptions } from "../services/decisions.js";
import { addDecisionDep } from "../services/dependencies.js";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(decisionDeps).where(inArray(decisionDeps.taskId, created.docs)).catch(() => {});
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
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
    .values({ email: `mcp-dec-${sub}@memex.ai` } as any)
    .returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, account: a, nsSlug: ns.slug };
}

// b-36 T-6 ref helpers (b-105 — /briefs/ → /specs/, b-N → spec-N).
function refForSpec(actor: { nsSlug: string }, doc: { handle: string }): string {
  return `${actor.nsSlug}/main/specs/${doc.handle}`;
}
function refForDecision(
  actor: { nsSlug: string },
  doc: { handle: string },
  seq: number,
): string {
  return `${refForSpec(actor, doc)}/decisions/dec-${seq}`;
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
  actor = await setupActor("dec");
});

describe("Decision extraction MCP tools (post-doc-14)", () => {
  it("registers the consolidated decision tools", () => {
    const server = createMcpServer(actor.user.id);
    const names = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    // propose_decision folded into create_decision({status:'candidate'}).
    expect(names).toContain("create_decision");
    expect(names).toContain("approve_candidate");
    expect(names).toContain("reject_candidate");
    // get_decision_impact was dropped — get_doc carries the same blocked-tasks info.
  });

  it("propose_decision creates a candidate decision with options (via create_decision)", async () => {
    const doc = await createDocDraft(actor.account.id, "Candidate Spec", "P", "spec");
    created.docs.push(doc.id);

    const result = await callTool(actor.user.id, "create_decision", {
      ref: refForSpec(actor, doc),
      title: "Cache invalidation approach?",
      context: "Conversation surfaced two viable approaches",
      status: "candidate",
      options: [
        { label: "Write-through", trade_offs: "Simpler, more writes" },
        { label: "TTL-based", trade_offs: "Cheaper, can serve stale data" },
      ],
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("Cache invalidation approach?");

    const decs = await db.query.decisions.findMany({ where: eq(decisions.docId, doc.id) });
    expect(decs).toHaveLength(1);
    expect(decs[0].status).toBe("candidate");
    const options = decs[0].options as Array<{ label: string; trade_offs: string }>;
    expect(options).toHaveLength(2);
    expect(options[0].label).toBe("Write-through");
  });

  it("approve_candidate moves a candidate to open", async () => {
    const doc = await createDocDraft(actor.account.id, "ApproveSpec", "P", "spec");
    created.docs.push(doc.id);
    const candidate = await proposeDecision(actor.account.id, doc.id, {
      title: "Q?",
      source: "agent",
    });

    const result = await callTool(actor.user.id, "approve_candidate", {
      ref: refForDecision(actor, doc, candidate.seq),
    });
    expect(result.isError).toBeFalsy();
    const reload = await db.query.decisions.findFirst({ where: eq(decisions.id, candidate.id) });
    expect(reload!.status).toBe("open");
  });

  it("approve_candidate rejects non-candidate decisions", async () => {
    const doc = await createDocDraft(actor.account.id, "ApproveErr", "P", "spec");
    created.docs.push(doc.id);
    const dec = await proposeDecision(actor.account.id, doc.id, { title: "Q?", source: "agent" });
    const decRef = refForDecision(actor, doc, dec.seq);
    // Approve once → open
    await callTool(actor.user.id, "approve_candidate", { ref: decRef });
    // Approve again → fail
    const second = await callTool(actor.user.id, "approve_candidate", { ref: decRef });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/Only candidate decisions/);
  });

  it("reject_candidate moves a candidate to rejected with the reason", async () => {
    const doc = await createDocDraft(actor.account.id, "RejectSpec", "P", "spec");
    created.docs.push(doc.id);
    const candidate = await proposeDecision(actor.account.id, doc.id, {
      title: "Q?",
      source: "agent",
    });

    const result = await callTool(actor.user.id, "reject_candidate", {
      ref: refForDecision(actor, doc, candidate.seq),
      reason: "Single-path action — not actually a decision",
    });
    expect(result.isError).toBeFalsy();
    const reload = await db.query.decisions.findFirst({ where: eq(decisions.id, candidate.id) });
    expect(reload!.status).toBe("rejected");
    expect(reload!.resolution).toContain("Single-path action");
  });

  // get_decision_impact was dropped in doc-14: the parent doc's get_doc output
  // already lists each decision and the tasks blocked by it (formatFullDocState's
  // task list calls out blockers explicitly). Reviewers can inspect impact via
  // get_doc({ref}) and read the BLOCKED-by-D-N task entries.

  it("get_doc on a Spec surfaces blocked tasks for an open decision (replaces get_decision_impact)", async () => {
    const doc = await createDocDraft(actor.account.id, "ImpactSpec", "P", "spec");
    created.docs.push(doc.id);
    const candidate = await proposeDecision(actor.account.id, doc.id, {
      title: "Decide what?",
      source: "agent",
      options: [
        { label: "A", trade_offs: "Pro/Con A" },
        { label: "B", trade_offs: "Pro/Con B" },
      ],
    });
    void setDecisionOptions; // keep import live for the helper signature in case API changes
    await callTool(actor.user.id, "approve_candidate", {
      ref: refForDecision(actor, doc, candidate.seq),
    });
    const item = await createTask(actor.account.id, doc.id, "Build A or B", "Desc");
    await addDecisionDep(actor.account.id, item.id, candidate.id);

    const result = await callTool(actor.user.id, "get_doc", { ref: refForSpec(actor, doc) });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("Decide what?");
    expect(text).toContain("Build A or B");
    expect(text).toMatch(/BLOCKED by dec-/);
  });

  it("resolve_decision passes chosenOptionIndex through", async () => {
    const doc = await createDocDraft(actor.account.id, "ResolveWithChoice", "P", "spec");
    created.docs.push(doc.id);
    const candidate = await proposeDecision(actor.account.id, doc.id, {
      title: "Pick one",
      source: "agent",
      options: [
        { label: "A", trade_offs: "..." },
        { label: "B", trade_offs: "..." },
      ],
    });
    const decRef = refForDecision(actor, doc, candidate.seq);
    await callTool(actor.user.id, "approve_candidate", { ref: decRef });

    const result = await callTool(actor.user.id, "resolve_decision", {
      ref: decRef,
      resolution: "Going with A",
      chosenOptionIndex: 0,
    });
    expect(result.isError).toBeFalsy();
    const reload = await db.query.decisions.findFirst({ where: eq(decisions.id, candidate.id) });
    expect(reload!.status).toBe("resolved");
    expect(reload!.chosenOptionIndex).toBe(0);
  });
});
