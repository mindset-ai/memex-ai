// spec-219 ac-8 / ac-9 — the footer SLOT: a handler parks its dynamic footer
// nugget in a stable ctx slot; the single seat folds it into the footer, so it
// lands AFTER the delimiter and is persisted to mcp_tool_calls.footer_text.
//
// ac-8: the handler hands the seat its dynamic footer content via the slot; the
//       seat composes it; the handler keeps its own DB read/write.
// ac-9: the parked string lands after FOOTER_DELIMITER and is captured in
//       mcp_tool_calls.footer_text by the telemetry split (it never was while
//       the nudge rode the body, before the delimiter).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, desc } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  decisions,
  tasks,
  users,
  mcpToolCalls,
  mcpSessions,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { createDocDraft } from "./documents.js";
import { COMPLETION_NUDGE } from "../agent/tool-specs.js";
import { FOOTER_DELIMITER, splitToolResult } from "../mcp/footer-delimiter.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-219/acs/ac-${n}`;

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as any).returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, memexId: a.id, nsSlug: ns.slug };
}

interface ToolResult { isError?: boolean; content: Array<{ type: string; text: string }> }
interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

async function callTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<ToolResult> {
  const server = createMcpServer(userId, undefined, sessionId);
  const registry = (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

async function pollFooter(sessionId: string): Promise<string | null | undefined> {
  for (let i = 0; i < 40; i++) {
    const [row] = await db
      .select({ footerText: mcpToolCalls.footerText })
      .from(mcpToolCalls)
      .where(eq(mcpToolCalls.sessionId, sessionId))
      .orderBy(desc(mcpToolCalls.createdAt))
      .limit(1);
    if (row?.footerText) return row.footerText;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

async function buildSpecWithTask(title: string): Promise<{ specRef: string; taskRef: string }> {
  const doc = await createDocDraft(actor.memexId, title, "Purpose.", "spec");
  created.docs.push(doc.id);
  await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
  const specRef = `${actor.nsSlug}/main/specs/${doc.handle}`;
  await callTool(actor.user.id, "create_task", {
    ref: specRef,
    title: "A unit of work",
    description: "Delivers something checkable.",
  });
  const task = await db.query.tasks.findFirst({ where: eq(tasks.docId, doc.id) });
  const taskRef = `${specRef}/tasks/t-${task!.seq}`;
  return { specRef, taskRef };
}

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("spec219-slot");
});

describe("ac-9 — the parked nugget lands after the delimiter and persists", () => {
  it("verbose update_task(complete) puts the completion nudge in the footer, not the body", async () => {
    tagAc(AC(9));
    const { taskRef } = await buildSpecWithTask("Slot Placement Spec");

    const res = await callTool(actor.user.id, "update_task", {
      ref: taskRef,
      status: "complete",
      verbose: true,
    });
    const text = res.content.map((c) => c.text).join("\n");

    const { body, footer } = splitToolResult(text);
    // The nugget moved OUT of the body and now rides the footer (past the delimiter).
    expect(body).not.toContain(COMPLETION_NUDGE);
    expect(footer).toContain(COMPLETION_NUDGE);
  });

  it("the completion nudge is captured in mcp_tool_calls.footer_text", async () => {
    tagAc(AC(9));
    const { taskRef } = await buildSpecWithTask("Slot Persistence Spec");

    const sessionId = `s219-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await db.insert(mcpSessions).values({ sessionId, userId: actor.user.id });

    const res = await callTool(
      actor.user.id,
      "update_task",
      { ref: taskRef, status: "complete", verbose: true },
      sessionId,
    );
    const emitted = splitToolResult(res.content.map((c) => c.text).join("\n")).footer;
    expect(emitted).toContain(COMPLETION_NUDGE);

    const persisted = await pollFooter(sessionId);
    expect(persisted).toBeTruthy();
    expect(persisted).toContain(COMPLETION_NUDGE);
  });
});

describe("ac-8 — a handler hands the seat a structured signal via the slot", () => {
  it("verbose update_doc routes transition GUIDANCE to the footer and the tag FACT to the body", async () => {
    tagAc(AC(8));
    const doc = await createDocDraft(actor.memexId, "Slot Tag Spec", "Purpose.", "spec");
    created.docs.push(doc.id);
    await db.update(documents).set({ status: "specify" }).where(eq(documents.id, doc.id));
    const ref = `${actor.nsSlug}/main/specs/${doc.handle}`;

    const res = await callTool(actor.user.id, "update_doc", {
      ref,
      status: "build",
      tags: ["priority::high"],
      verbose: true,
    });
    const text = res.content.map((c) => c.text).join("\n");
    const { body, footer } = splitToolResult(text);

    // spec-219 Phase 2 (sole-author): the handler signalled the transition (the
    // DATA — its own status write stayed in the handler); composeGuidanceEnvelope
    // authored the transition GUIDANCE, which rides the footer past the delimiter.
    expect(footer).toMatch(/assess_spec/);
    // The tag summary is RESULT-REPORTING (a fact), so it rides the body, never
    // the footer.
    expect(body).toContain("tagged priority::high");
    expect(footer).not.toContain("tagged priority::high");
    // And the handler's write actually landed.
    const fresh = await db.query.documents.findFirst({ where: eq(documents.id, doc.id) });
    expect(fresh?.status).toBe("build");
  });
});
