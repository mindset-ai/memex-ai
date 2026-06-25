// spec-219 comb-through: create_decision emits a forward-only lifecycle CTA
// (resolve it, or defer the load-bearing call to the user), replacing the bare
// related-issues nudge that left the common case (no overlapping issue) falling
// to the phase-essence wall. The related-issues nudge still appends underneath
// when it fires. Words live in renderFooterSignal; this exercises the real MCP
// path end to end.

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
  users,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { splitToolResult } from "../mcp/footer-delimiter.js";

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

afterAll(async () => {
  if (created.docs.length) {
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
async function callTool(userId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const server = createMcpServer(userId);
  const registry = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> | ToolResult }> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const res = await tool.handler(args, {} as unknown);
  return res.content.map((c) => c.text).join("\n");
}

describe("create_decision forward-only footer CTA", () => {
  it("emits resolve-or-defer guidance instead of the bare wall", async () => {
    const actor = await setupActor("create-decision-footer");
    const out = await callTool(actor.user.id, "create_doc", {
      memex: `${actor.nsSlug}/main`,
      title: "Decision footer probe",
      purpose: "Probe.",
    });
    const handle = out.match(/specs\/(spec-\d+)/)?.[1];
    const doc = await db.query.documents.findFirst({ where: eq(documents.handle, handle!) });
    created.docs.push(doc!.id);
    const ref = `${actor.nsSlug}/main/specs/${handle}`;

    const decOut = await callTool(actor.user.id, "create_decision", {
      ref,
      title: "A fork the work hinges on.",
    });
    const footer = splitToolResult(decOut).footer ?? "";

    // forward-looking: the next move is to resolve it
    expect(footer).toContain("Resolve it with resolve_decision");
    // the user's-call guardrail is present, lifted from the wall
    expect(footer).toContain("load-bearing call only the user should make");
    expect(footer).toContain("leave it open");
    // and it is NOT just the generic phase-essence wall
    expect(footer).not.toContain("PREDICTIVE standards pass");
  });
});
