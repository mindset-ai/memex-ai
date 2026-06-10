// spec-122 t-2 (dec-5) — identity threading onto the source-table write path.
//
//   ac-18  actor + channel ride the existing explicit RequestCtx through
//          mutate(ctx, …); NO AsyncLocalStorage is introduced.
//   ac-19  a mutation ORIGINATING FROM THE MCP entry path lands channel='mcp'
//          (driven through the real create_task tool handler).
//   ac-20  writes to acs / tasks / decisions / doc_sections record
//          actor_user_id + actor_name for an authenticated user.
//   ac-10  actor_name is denormalised at write — a later user rename does NOT
//          rewrite the historical attribution on the past row.
//
// TAGGED with tagAc → reports to the PROD memex. A human runs it with
// MEMEX_EMIT_KEY set; auto mode skips tagged suites.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  acs,
  tasks,
  decisions,
  docSections,
} from "../db/schema.js";
import { createTask } from "./tasks.js";
import { createAc } from "./acs.js";
import { createDecision } from "./decisions.js";
import { addSection } from "./sections.js";
import { createDocDraft } from "./documents.js";
import { createMcpServer } from "../mcp/tools.js";
import type { RequestCtx } from "./mutate.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-122/acs";

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `s122-${sub}@memex.ai`, name: "Christine" } as typeof users.$inferInsert)
    .returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, memexId: a.id, nsSlug: ns.slug };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}
async function callTool(userId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (
    server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> }> }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

let actor: Awaited<ReturnType<typeof setupActor>>;
let docId: string;

beforeAll(async () => {
  actor = await setupActor("thread");
  const doc = await createDocDraft(actor.memexId, "Threading", "T", "spec");
  docId = doc.id;
  created.docs.push(docId);
});

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("regression: actor + channel threading [spec-122 t-2]", () => {
  // ── ac-20 ───────────────────────────────────────────────────────────────
  it("ac-20: createAc stamps actor_user_id + actor_name + channel for an authenticated user", async () => {
    tagAc(`${AC}/ac-20`);
    const ctx: RequestCtx = { actorUserId: actor.user.id, channel: "mcp" };
    const ac = await createAc({ memexId: actor.memexId, briefId: docId, kind: "scope", statement: "stamped AC" }, ctx);
    const [row] = await db.select().from(acs).where(eq(acs.id, ac.id));
    expect(row.actorUserId).toBe(actor.user.id);
    expect(row.actorName).toBe("Christine");
    expect(row.channel).toBe("mcp");
  });

  it("ac-20: createTask stamps the contract columns", async () => {
    tagAc(`${AC}/ac-20`);
    const task = await createTask(
      actor.memexId, docId, "stamped task", "desc", undefined, undefined,
      { actorUserId: actor.user.id, channel: "rest_ui" },
    );
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.actorUserId).toBe(actor.user.id);
    expect(row.actorName).toBe("Christine");
    expect(row.channel).toBe("rest_ui");
  });

  it("ac-20: createDecision stamps the contract columns", async () => {
    tagAc(`${AC}/ac-20`);
    const dec = await createDecision(
      actor.memexId, docId, "stamped decision", "context", "human",
      { actorUserId: actor.user.id, channel: "in_app_agent" },
    );
    const [row] = await db.select().from(decisions).where(eq(decisions.id, dec.id));
    expect(row.actorUserId).toBe(actor.user.id);
    expect(row.actorName).toBe("Christine");
    expect(row.channel).toBe("in_app_agent");
  });

  it("ac-20: addSection stamps the contract columns", async () => {
    tagAc(`${AC}/ac-20`);
    const section = await addSection(
      actor.memexId, docId, "approach", "section body", "Approach", undefined,
      { actorUserId: actor.user.id, channel: "rest_ui" },
    );
    const [row] = await db.select().from(docSections).where(eq(docSections.id, section.id));
    expect(row.actorUserId).toBe(actor.user.id);
    expect(row.actorName).toBe("Christine");
    expect(row.channel).toBe("rest_ui");
  });

  // ── ac-10 ───────────────────────────────────────────────────────────────
  it("ac-10: actor_name is denormalised — a later user rename does not rewrite past attribution", async () => {
    tagAc(`${AC}/ac-10`);
    const ac = await createAc(
      { memexId: actor.memexId, briefId: docId, kind: "implementation", statement: "history AC" },
      { actorUserId: actor.user.id, channel: "mcp" },
    );
    const [before] = await db.select().from(acs).where(eq(acs.id, ac.id));
    expect(before.actorName).toBe("Christine");

    // Rename the user — the historical row must NOT change.
    await db.update(users).set({ name: "Christine Renamed" }).where(eq(users.id, actor.user.id));
    const [after] = await db.select().from(acs).where(eq(acs.id, ac.id));
    expect(after.actorName).toBe("Christine"); // frozen snapshot, not a join

    // restore for the other tests
    await db.update(users).set({ name: "Christine" }).where(eq(users.id, actor.user.id));
  });

  // ── ac-18 ───────────────────────────────────────────────────────────────
  it("ac-18: actor + channel ride the explicit RequestCtx through mutate (row reflects ctx)", async () => {
    tagAc(`${AC}/ac-18`);
    // The ONLY input that carried the attribution was the RequestCtx — no thread-local.
    const task = await createTask(
      actor.memexId, docId, "ctx task", "desc", undefined, undefined,
      { actorUserId: actor.user.id, channel: "in_app_agent" },
    );
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.channel).toBe("in_app_agent");
    expect(row.actorUserId).toBe(actor.user.id);
  });

  it("ac-18: no AsyncLocalStorage is used on the write path (mechanism is the explicit ctx)", async () => {
    tagAc(`${AC}/ac-18`);
    const here = dirname(fileURLToPath(import.meta.url));
    // Match real USAGE (import / instantiation), not a mention in prose — dec-5's
    // own narrative names AsyncLocalStorage as the rejected option.
    const usage = /from ["']node:async_hooks["']|require\(["']async_hooks["']\)|new AsyncLocalStorage/;
    for (const f of ["mutate.ts", "actor.ts", "acs.ts", "tasks.ts", "decisions.ts", "sections.ts"]) {
      const src = readFileSync(resolve(here, f), "utf8");
      expect(src, `${f} must not use AsyncLocalStorage`).not.toMatch(usage);
    }
  });

  // ── ac-19 ───────────────────────────────────────────────────────────────
  it("ac-19: a task created through the MCP entry path lands channel='mcp'", async () => {
    tagAc(`${AC}/ac-19`);
    const ref = `${actor.nsSlug}/main/specs/${(await db.select().from(documents).where(eq(documents.id, docId)))[0].handle}`;
    const result = await callTool(actor.user.id, "create_task", {
      ref,
      title: "mcp-origin task",
      description: "created via the MCP create_task tool",
    });
    expect(result.isError ?? false).toBe(false);

    // The write originated on the MCP surface → channel='mcp', attributed to the user.
    const [row] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.docId, docId), eq(tasks.title, "mcp-origin task")));
    expect(row.channel).toBe("mcp");
    expect(row.actorUserId).toBe(actor.user.id);
    // actor_name was resolved at write time even though the MCP ctx carried no name.
    expect(row.actorName).toBe("Christine");
  });
});
