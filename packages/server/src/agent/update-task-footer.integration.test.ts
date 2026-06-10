// spec-219 comb-through: update_task (complete) emits a de-jargoned progress note,
// and when it's the LAST task it pushes toward verify (the build->verify analogue
// of create_ac's build-push). Words live in renderFooterSignal; this exercises the
// real MCP path end to end.

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  tasks,
  users,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { splitToolResult } from "../mcp/footer-delimiter.js";

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
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
async function callTool(userId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const server = createMcpServer(userId);
  const registry = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> | ToolResult }> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const res = await tool.handler(args, {} as unknown);
  return res.content.map((c) => c.text).join("\n");
}

describe("update_task footer: progress note + verify-push on the last task", () => {
  it("names remaining tasks, then pushes to verify when the last one completes", async () => {
    const actor = await setupActor("update-task-footer");
    const out = await callTool(actor.user.id, "create_doc", {
      memex: `${actor.nsSlug}/main`,
      title: "Task footer probe",
      purpose: "Probe.",
    });
    const handle = out.match(/specs\/(spec-\d+)/)?.[1];
    const doc = await db.query.documents.findFirst({ where: eq(documents.handle, handle!) });
    created.docs.push(doc!.id);
    const ref = `${actor.nsSlug}/main/specs/${handle}`;
    // jump to build so tasks can be created and completed
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc!.id));

    const t1 = (await callTool(actor.user.id, "create_task", { ref, title: "Task one.", description: "Body." })).match(/tasks\/(t-\d+)/)![1];
    const t2 = (await callTool(actor.user.id, "create_task", { ref, title: "Task two.", description: "Body." })).match(/tasks\/(t-\d+)/)![1];

    // complete t1: one still open, no verify push yet
    const mid = splitToolResult(await callTool(actor.user.id, "update_task", {
      ref: `${ref}/tasks/${t1}`,
      status: "complete",
    })).footer ?? "";
    expect(mid).toContain("comment for whoever picks this up next");
    expect(mid).toContain("1 task still open");
    expect(mid).not.toContain("update_doc");

    // complete t2 (the last): the verify-push fires
    const last = splitToolResult(await callTool(actor.user.id, "update_task", {
      ref: `${ref}/tasks/${t2}`,
      status: "complete",
    })).footer ?? "";
    expect(last).toContain("That was the last task");
    expect(last).toContain("update_doc({status:'verify'})");
  });
});
