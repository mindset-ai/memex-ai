// spec-471 t-2 — the no-arg READ default is DISCLOSED, not silent (dec-3).
//
// End-to-end through createMcpServer against a real Postgres. A multi-workspace
// caller invokes a read tool (list_docs) WITHOUT a `memex=` arg; the server
// auto-picks their most-recently-used memex (t-1) and MUST prefix the tool
// result with a one-line disclosure naming that memex in `<ns>/<mx>` form plus
// the override. An explicit-`memex=` call emits no such line.
//
// Tagged to:
//   mindset-prod/memex-building-itself/specs/spec-471/acs/ac-5 (disclosure line present/absent)
//   mindset-prod/memex-building-itself/specs/spec-471/acs/ac-8 (user can tell which was chosen + how to override)

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  users,
  mcpSessions,
  mcpToolCalls,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-471/acs";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  sessions: [] as string[],
};

afterAll(async () => {
  if (created.sessions.length) {
    await db.delete(mcpSessions).where(inArray(mcpSessions.sessionId, created.sessions)).catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
});

async function makeUser(suffix: string) {
  const [u] = await db
    .insert(users)
    .values({ email: `s471-disc-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@memex.ai` } as any)
    .returning();
  created.users.push(u.id);
  return u;
}

async function makeAccount(sub: string): Promise<{ id: string; slug: string }> {
  const slug = `${sub}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase().slice(0, 39);
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: sub }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ name: sub, slug: "main", namespaceId: ns.id }).returning();
  created.memexes.push(a.id);
  return { id: a.id, slug: ns.slug };
}

async function addMember(userId: string, memexId: string) {
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) return;
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, memex.namespaceId) });
  if (!ns?.ownerOrgId) return;
  await db.insert(orgMemberships).values({ userId, orgId: ns.ownerOrgId, role: "member" });
}

async function recordToolCall(userId: string, memexId: string, at: Date) {
  const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(mcpSessions).values({ sessionId, userId } as any);
  created.sessions.push(sessionId);
  await db
    .insert(mcpToolCalls)
    .values({ sessionId, userId, memexId, toolName: "search_memex", argsJson: {}, durationMs: 0, createdAt: at } as any);
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}
interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

async function callTool(userId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (
    server as unknown as { _registeredTools: Record<string, RegisteredToolLike> }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const withVerbose = "verbose" in args ? args : { ...args, verbose: true };
  return await tool.handler(withVerbose, {} as unknown);
}

describe("no-arg read default disclosure (spec-471)", () => {
  it("prefixes the result with the auto-picked memex + override when no memex= is given", async () => {
    tagAc(`${AC}/ac-5`);
    tagAc(`${AC}/ac-8`);
    const u = await makeUser("present");
    const a = await makeAccount("s471d-a");
    const b = await makeAccount("s471d-b");
    await addMember(u.id, a.id);
    await addMember(u.id, b.id);
    // b is most recently used → the default the caller must be told about.
    await recordToolCall(u.id, a.id, new Date(Date.now() - 60_000));
    await recordToolCall(u.id, b.id, new Date(Date.now() - 1_000));

    const res = await callTool(u.id, "list_docs", {});
    const text = res.content[0].text;
    expect(text).toMatch(/^Defaulted to memex /);
    expect(text).toContain(`${b.slug}/main`); // names the CHOSEN memex (ac-8)
    expect(text).toContain("Pass memex=<namespace>/<memex>"); // states the override (ac-8)
  });

  it("emits NO disclosure line when memex= is passed explicitly", async () => {
    tagAc(`${AC}/ac-5`);
    const u = await makeUser("absent");
    const a = await makeAccount("s471d-x");
    const b = await makeAccount("s471d-y");
    await addMember(u.id, a.id);
    await addMember(u.id, b.id);
    await recordToolCall(u.id, b.id, new Date());

    const res = await callTool(u.id, "list_docs", { memex: `${a.slug}/main` });
    expect(res.content[0].text).not.toContain("Defaulted to memex");
  });
});
