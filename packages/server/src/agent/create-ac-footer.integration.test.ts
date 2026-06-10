// spec-219 comb-through: create_ac emits a COUNT-AWARE scope-AC call to action
// (net-new guidance — prod had no create_ac footer). The behaviour we pin:
//   - below 6 scope ACs: fit-framed "keep going", and crucially NO "likely
//     captures done" reassurance (so the count can't anchor the agent at 3);
//   - at 6+: the reassurance appears, with the confirm-with-user + move-to-
//     decisions call to action.
// The words live in renderFooterSignal; this exercises the real MCP path so the
// signal -> composeGuidanceEnvelope -> footer wiring is covered end to end.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  acs,
  users,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { splitToolResult } from "../mcp/footer-delimiter.js";

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
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

describe("create_ac count-aware scope footer", () => {
  let actor: Awaited<ReturnType<typeof setupActor>>;
  let ref: string;

  beforeAll(async () => {
    actor = await setupActor("create-ac-footer");
    const out = await callTool(actor.user.id, "create_doc", {
      memex: `${actor.nsSlug}/main`,
      title: "Count-aware footer probe",
      purpose: "Probe.",
    });
    const handle = out.match(/specs\/(spec-\d+)/)?.[1];
    const doc = await db.query.documents.findFirst({ where: eq(documents.handle, handle!) });
    created.docs.push(doc!.id);
    ref = `${actor.nsSlug}/main/specs/${handle}`;
  });

  async function addScopeAc(i: number): Promise<string> {
    const out = await callTool(actor.user.id, "create_ac", {
      ref,
      kind: "scope",
      statement: `Outcome ${i} the system must deliver.`,
    });
    return splitToolResult(out).footer ?? "";
  }

  it("below six: fit-framed, and never the 'likely captures done' reassurance", async () => {
    for (let i = 1; i <= 5; i++) {
      const footer = await addScopeAc(i);
      expect(footer, `count ${i} should report the live count`).toContain(`${i} scope acceptance criteri`);
      expect(footer, `count ${i} should frame on fit, not a number`).toContain("rather than to reach a number");
      expect(footer, `count ${i} must NOT prematurely say it's done`).not.toContain("likely captures");
    }
  });

  it("at six: flips to 'likely captures done' + confirm + move to decisions", async () => {
    const footer = await addScopeAc(6);
    expect(footer).toContain("6 scope acceptance criteria");
    expect(footer).toContain("likely captures what \"done\" means");
    expect(footer).toContain("check with the user");
    expect(footer).toContain("create_decision");
  });
});
