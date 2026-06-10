// THE INVARIANT: composeGuidanceEnvelope is the SOLE author of platform guidance
// (headers + footers). No tool handler may craft guidance of its own.
//
// How we prove it behaviourally: the choke point assembles
// `header + body + FOOTER_DELIMITER + footer`. Everything AFTER the delimiter is
// composeGuidanceEnvelope's footer (allowed); the only guidance permitted BEFORE
// the delimiter is composeGuidanceEnvelope's coverage header (`**AC coverage:**`).
// Anything else before the delimiter is a handler that authored its own guidance
// — a violation. So: split each tool response at the delimiter, and assert the
// body carries none of the known handler-authored guidance signatures.
//
// This test is RED until every handler nudge is re-homed into
// composeGuidanceEnvelope. Extend HANDLER_GUIDANCE as new offenders surface.

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
  users,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { createDocDraft } from "./documents.js";
import { splitToolResult } from "../mcp/footer-delimiter.js";
import { PROD_FOOTER_BASELINE } from "../__regression__/prod-footer-baseline.js";

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
async function callTool(userId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const server = createMcpServer(userId);
  const registry = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> | ToolResult }> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const res = await tool.handler(args, {} as unknown);
  return res.content.map((c) => c.text).join("\n");
}

// Guidance a HANDLER must never author. The coverage HEADER ("**AC coverage:**
// N of M …") is composeGuidanceEnvelope's and is deliberately NOT here; the
// update_doc coverage NUDGE ("AC coverage: X% …") is a handler's and IS.
const HANDLER_GUIDANCE: Array<{ label: string; re: RegExp }> = [
  { label: "resolve_decision impl-AC push", re: /Next: author the implementation AC/i },
  { label: "create_doc scope-AC push", re: /Next: author Scope ACs/i },
  { label: "update_doc transition tip", re: /Tip:\s*run assess_spec/i },
  { label: "update_doc coverage nudge", re: /AC coverage:\s*\d+%/i },
  { label: "update_task completion nudge", re: /leave a `progress` comment/i },
];

/** The region a handler is responsible for: everything before the platform
 *  delimiter. If a guidance signature appears here, a handler authored it. */
function bodyRegion(response: string): string {
  return splitToolResult(response).body;
}

function assertNoHandlerGuidance(response: string, toolLabel: string) {
  const body = bodyRegion(response);
  const offenders = HANDLER_GUIDANCE.filter((g) => g.re.test(body)).map((g) => g.label);
  expect(offenders, `${toolLabel} authored guidance before the delimiter: ${offenders.join(", ")}`).toEqual([]);
}

// Net-improvement / nothing-dropped: the prod guidance a relocated tool used to
// author before the delimiter must STILL appear, now in the footer (after the
// delimiter, composed by composeGuidanceEnvelope). Golden strings captured live
// from prod in prod-footer-baseline.ts.
function assertFooterPreservesProd(response: string, tool: string) {
  const base = PROD_FOOTER_BASELINE.find((b) => b.tool === tool);
  if (!base) throw new Error(`no prod baseline recorded for ${tool}`);
  const footer = splitToolResult(response).footer ?? "";
  for (const s of base.stableSubstrings) {
    expect(
      footer.includes(s),
      `${tool}: prod guidance "${s}" must survive the relocation, in the footer`,
    ).toBe(true);
  }
}

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("sole-author");
});

async function freshSpec(title: string, status: "specify" | "build"): Promise<{ id: string; ref: string }> {
  const doc = await createDocDraft(actor.memexId, title, "Purpose.", "spec");
  created.docs.push(doc.id);
  await db.update(documents).set({ status }).where(eq(documents.id, doc.id));
  return { id: doc.id, ref: `${actor.nsSlug}/main/specs/${doc.handle}` };
}

describe("composeGuidanceEnvelope is the sole author of platform guidance", () => {
  it("create_doc body carries no handler-authored guidance", async () => {
    const out = await callTool(actor.user.id, "create_doc", {
      memex: `${actor.nsSlug}/main`,
      title: "Sole-author create_doc probe",
      purpose: "Probe.",
    });
    // record for cleanup (parse the handle out of the ref line)
    const m = out.match(/specs\/(spec-\d+)/);
    if (m) {
      const d = await db.query.documents.findFirst({ where: eq(documents.handle, m[1]) });
      if (d) created.docs.push(d.id);
    }
    assertNoHandlerGuidance(out, "create_doc");
  });

  it("update_doc (forward transition) body carries no handler-authored guidance", async () => {
    const { ref } = await freshSpec("Sole-author update_doc probe", "specify");
    const out = await callTool(actor.user.id, "update_doc", { ref, status: "build" });
    assertNoHandlerGuidance(out, "update_doc");
  });

  it("resolve_decision body carries no handler-authored guidance", async () => {
    const { ref } = await freshSpec("Sole-author resolve_decision probe", "build");
    const dec = await callTool(actor.user.id, "create_decision", { ref, title: "A fork to resolve." });
    const decRef = dec.match(/decisions\/(dec-\d+)/)?.[1];
    const out = await callTool(actor.user.id, "resolve_decision", {
      ref: `${ref}/decisions/${decRef}`,
      resolution: "Chosen.",
    });
    assertNoHandlerGuidance(out, "resolve_decision");
    assertFooterPreservesProd(out, "resolve_decision");
  });

  it("update_task (complete) body carries no handler-authored guidance", async () => {
    const { ref } = await freshSpec("Sole-author update_task probe", "build");
    const task = await callTool(actor.user.id, "create_task", {
      ref,
      title: "A task to complete.",
      description: "Body.",
    });
    const taskRef = task.match(/tasks\/(t-\d+)/)?.[1];
    const out = await callTool(actor.user.id, "update_task", {
      ref: `${ref}/tasks/${taskRef}`,
      status: "complete",
    });
    assertNoHandlerGuidance(out, "update_task");
    assertFooterPreservesProd(out, "update_task");
  });
});
