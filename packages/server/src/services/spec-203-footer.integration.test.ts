// spec-203 ac-14 / ac-17 — the footer rides EVERY Spec-resolving response (terse
// and verbose), authored by the one seat, and is persisted.
//
// Before this work the footer rode only verbose document reads (prod audit: 14 of
// 9,494 calls). Now a chat-driven agent gets steered on its terse build-loop
// calls too — and what it received is captured in mcp_tool_calls.footer_text.

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
import { FOOTER_DELIMITER, splitToolResult } from "../mcp/footer-delimiter.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-203/acs/ac-${n}`;

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

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("spec203-footer");
});

describe("ac-14 — the footer rides terse Spec-resolving responses", () => {
  it("a TERSE get_doc on a build-phase Spec comes back WITH the footer (the seat's lean steer)", async () => {
    tagAc(AC(14));
    const doc = await createDocDraft(actor.memexId, "Terse Footer Spec", "P", "spec");
    created.docs.push(doc.id);
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
    const ref = `${actor.nsSlug}/main/specs/${doc.handle}`;

    // verbose omitted (the terse default) — pre-change this had no footer.
    const res = await callTool(actor.user.id, "get_doc", { ref });
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain(FOOTER_DELIMITER);
    // Lean terse footer = the phase essence, authored by the seat.
    const footer = splitToolResult(text).footer;
    expect(footer).toBeTruthy();
    expect(footer).toMatch(/You are now in build/);
  });

  it("the seat crafts the lean AC-nag when the build Spec has untested ACs", async () => {
    tagAc(AC(14));
    const doc = await createDocDraft(actor.memexId, "Nag Spec", "P", "spec");
    created.docs.push(doc.id);
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
    const ref = `${actor.nsSlug}/main/specs/${doc.handle}`;
    // Author an AC (active, untested) so the nag has something to say.
    await callTool(actor.user.id, "create_ac", { ref, kind: "scope", statement: "A checkable outcome." });

    const res = await callTool(actor.user.id, "get_doc", { ref });
    const footer = splitToolResult(res.content.map((c) => c.text).join("\n")).footer ?? "";
    expect(footer).toMatch(/untested acceptance criteri/i);
    expect(footer).toMatch(/don't go dark/i);
  });
});

describe("ac-17 — footer emitted ⇒ footer persisted", () => {
  it("the terse footer is captured in mcp_tool_calls.footer_text", async () => {
    tagAc(AC(17));
    const doc = await createDocDraft(actor.memexId, "Persisted Footer Spec", "P", "spec");
    created.docs.push(doc.id);
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
    const ref = `${actor.nsSlug}/main/specs/${doc.handle}`;

    // A real MCP session threads a sessionId (FK to mcp_sessions) — seed it.
    const sessionId = `s203-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await db.insert(mcpSessions).values({ sessionId, userId: actor.user.id });
    const res = await callTool(actor.user.id, "get_doc", { ref }, sessionId);
    const emitted = splitToolResult(res.content.map((c) => c.text).join("\n")).footer;
    expect(emitted).toBeTruthy();

    const persisted = await pollFooter(sessionId);
    expect(persisted).toBeTruthy();
    expect(persisted).toMatch(/You are now in build/);
  });
});
