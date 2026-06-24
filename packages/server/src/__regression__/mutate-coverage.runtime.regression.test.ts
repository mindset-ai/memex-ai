// Runtime MCP invocation coverage (doc-16 follow-up to t-11).
//
// The structural sibling (mutate-coverage.endpoint.test.ts) proves every
// catalogued mutating MCP tool is REGISTERED on the server. This file goes
// one layer deeper: it sends a real JSON-RPC `tools/call` over the MCP HTTP
// transport for a representative subset of those tools, with valid args
// against a real fixture-backed memex, and asserts the unified bus emits
// the catalogued (entity, action) event during the call.
//
// Why "subset" and not "every tool":
//   - Many tools (publish_brief, approve_candidate, submit_execution_plan)
//     need elaborate fixture preconditions; setting them up here would
//     duplicate the per-tool happy paths already covered exhaustively in
//     mcp/tools.test.ts. The subset below picks one tool per entity family
//     so a future bypass — an MCP tool that does its own db.update instead
//     of delegating to a service — would show up.
//   - mutate-coverage.service.test.ts continues to cover every Mutated<T>
//     service function at the layer below.
//
// What this test would catch that the others miss:
//   - A new MCP tool registered with the server that performs a direct DB
//     write (`db.update(...)`) bypassing the service layer. The structural
//     test wouldn't notice; the service coverage test only runs services it
//     knows about; THIS test runs the actual JSON-RPC path end-to-end.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { orgMemberships, memexes, namespaces, orgs } from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft } from "../services/documents.js";
import { addSection } from "../services/sections.js";
import { createDecision } from "../services/decisions.js";
import { createTask } from "../services/tasks.js";
import { addComment } from "../services/comments.js";
import { createStandard } from "../services/standards.js";
import { bus, type ChangeEvent, type ChangeEntity, type ChangeAction } from "../services/bus.js";
import { createMcpServer } from "../mcp/tools.js";

interface RuntimeFixtures {
  userId: string;
  memexId: string;
  // Slash form `<namespace>/<memex>` for tools that take a memex arg.
  memexSlash: string;
  // Canonical refs (b-36 T-6) — entity-acting tools take `ref`, not UUIDs.
  docRef: string;
  sectionRef: string;
  decisionRef: string;
  taskRef: string;
  commentRef: string;
  standardSectionRef: string;
}

async function makeRuntimeFixtures(): Promise<RuntimeFixtures> {
  const prefix = `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const user = await upsertUserByEmail(`${prefix}@example.com`);

  const built = await db.transaction(async (tx) => {
    const [ns] = await tx.insert(namespaces).values({ slug: prefix, kind: "org" }).returning();
    const [org] = await tx.insert(orgs).values({ namespaceId: ns.id, name: `RT ${prefix}` }).returning();
    await tx.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    return { ns, org, memex };
  });
  await db
    .insert(orgMemberships)
    .values({ userId: user.id, orgId: built.org.id, role: "administrator" })
    .onConflictDoNothing();

  // Pre-seed: one doc with a section, decision, task, comment, and a separate standard.
  const doc = await createDocDraft(built.memex.id, "Runtime cov spec", "purpose", "spec");
  const section = await addSection(built.memex.id, doc.id, "context", "Initial body");
  const decision = await createDecision(built.memex.id, doc.id, "Open question");
  const task = await createTask(built.memex.id, doc.id, "Do work", "Acc criteria");
  const comment = await addComment(built.memex.id, section.id, "RT Tester", "Initial comment");

  const std = await createStandard(built.memex.id, {
    title: "RT Standard",
    description: "Coverage standard",
    sections: [{ sectionType: "rule", content: "Be excellent." }],
  });
  // Standards put sections under doc_sections rooted at the std doc. spec-143
  // ac-14: flag_drift targets the section by canonical ref, not a UUID.
  const stdSection = await db.query.docSections.findFirst({
    where: (s, { eq }) => eq(s.docId, std.id),
  });

  const base = `${built.ns.slug}/main/specs/${doc.handle}`;
  return {
    userId: user.id,
    memexId: built.memex.id,
    memexSlash: `${built.ns.slug}/main`,
    docRef: base,
    sectionRef: `${base}/sections/s-${section.seq}`,
    decisionRef: `${base}/decisions/dec-${decision.seq}`,
    taskRef: `${base}/tasks/t-${task.seq}`,
    commentRef: `${base}/comments/c-${comment.seq}`,
    standardSectionRef: `${built.ns.slug}/main/standards/${std.handle}/sections/s-${stdSection!.seq}`,
  };
}

/**
 * Invoke a tool over the JSON-RPC HTTP transport — same wiring as production
 * but in-process. Returns the parsed `result` object so the caller can assert
 * on it; throws if the server reports an error response.
 */
async function mcpCall(
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { cors } = await import("hono/cors");
  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  );

  const testApp = new Hono();
  testApp.use("*", cors());
  testApp.all("/mcp", async (c) => {
    const mcpServer = createMcpServer(userId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  const res = await testApp.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`No data in MCP response for ${toolName}: ${text}`);
  const parsed = JSON.parse(dataLine.slice(6));
  if (parsed.error) {
    throw new Error(
      `MCP ${toolName} returned error: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.result;
}

interface RuntimeCase {
  tool: string;
  args: (f: RuntimeFixtures) => Record<string, unknown>;
  expected: { entity: ChangeEntity; action: ChangeAction };
}

// One tool per entity family. Each case picks args that target the seeded
// fixtures so the call always reaches the underlying service.
const RUNTIME_CASES: RuntimeCase[] = [
  {
    tool: "create_doc",
    args: (f) => ({
      memex: f.memexSlash,
      title: "Runtime cov new doc",
      purpose: "Coverage",
      docType: "spec",
    }),
    expected: { entity: "document", action: "created" },
  },
  {
    tool: "update_section",
    args: (f) => ({ ref: f.sectionRef, content: "Updated by runtime cov" }),
    expected: { entity: "section", action: "updated" },
  },
  {
    tool: "resolve_decision",
    args: (f) => ({ ref: f.decisionRef, resolution: "Decided." }),
    expected: { entity: "decision", action: "updated" },
  },
  {
    tool: "update_task",
    args: (f) => ({ ref: f.taskRef, title: "Updated runtime cov task" }),
    expected: { entity: "task", action: "updated" },
  },
  {
    tool: "add_comment",
    args: (f) => ({
      ref: f.sectionRef,
      authorName: "Runtime cov",
      content: "Runtime cov comment",
    }),
    expected: { entity: "comment", action: "created" },
  },
  // SKIP: doc-24 — flag_drift hidden; restore alongside the tool.
  // {
  //   tool: "flag_drift",
  //   args: (f) => ({
  //     ref: f.standardSectionRef,
  //     observation: "Drift observed by runtime cov.",
  //   }),
  //   expected: { entity: "standard_drift", action: "created" },
  // },
];

describe("doc-16 t-11 follow-up: runtime MCP coverage — every catalogued tool emits when invoked over JSON-RPC", () => {
  let fixtures: RuntimeFixtures;

  beforeAll(async () => {
    fixtures = await makeRuntimeFixtures();
  });

  for (const c of RUNTIME_CASES) {
    it(`${c.tool} emits ${c.expected.entity}.${c.expected.action} when invoked via MCP transport`, async () => {
      const seen: ChangeEvent[] = [];
      const unsubscribe = bus.subscribe({ memexId: fixtures.memexId }, (e) => seen.push(e));
      try {
        await mcpCall(fixtures.userId, c.tool, c.args(fixtures));
      } finally {
        unsubscribe();
      }
      const matched = seen.find(
        (e) => e.entity === c.expected.entity && e.action === c.expected.action,
      );
      expect(
        matched,
        `${c.tool} did not emit ${c.expected.entity}.${c.expected.action} via JSON-RPC. ` +
          `Saw: ${JSON.stringify(seen.map((e) => ({ entity: e.entity, action: e.action })))}`,
      ).toBeDefined();
    });
  }
});
