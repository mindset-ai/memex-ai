// spec-295 dec-3: the web agent (in_app_agent channel) no longer auto-advances
// phase, so a newly created Spec gets its starting phase by EXPLICIT placement.
//   - create_doc on the in_app_agent channel (the creation modal + the in-app
//     spec agent) places the new Spec directly in `specify` (ac-1, ac-12).
//   - the in-app agent never advances a Spec's phase as a side effect: a
//     build-class tool call on that channel leaves the phase put (ac-2, ac-4).
//   - the mcp channel is unchanged — create_doc still lands in `draft` (it
//     auto-advances later via traffic), so the asymmetry is deliberate.

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  tasks,
  acs,
  decisions,
  users,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { executeServerTool } from "./tools.js";
import { createTask } from "../services/tasks.js";

const SPEC295 = "mindset-prod/memex-building-itself/specs/spec-295";
const AC = (n: number) => `${SPEC295}/acs/ac-${n}`;

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
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
async function callMcp(userId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const server = createMcpServer(userId);
  const registry = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> | ToolResult }> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const res = await tool.handler(args, {} as unknown);
  return res.content.map((c) => c.text).join("\n");
}

async function docFor(out: string, memexId: string) {
  const handle = out.match(/specs\/(spec-\d+)/)?.[1];
  // Handles are per-memex (every memex has its own spec-1), so the lookup MUST
  // be scoped by memexId — otherwise it can match another test's same-handle Spec.
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.handle, handle!), eq(documents.memexId, memexId)),
  });
  created.docs.push(doc!.id);
  return doc!;
}

describe("spec-295 dec-3: web-agent creation lands in specify; phase stays human-owned", () => {
  it("create_doc on the in_app_agent channel places the new Spec in specify, never build (ac-1, ac-12)", async () => {
    tagAc(AC(1));
    tagAc(AC(12));
    const actor = await setupActor("create-inapp");
    const out = await executeServerTool(
      actor.memexId,
      "create_doc",
      { memex: `${actor.nsSlug}/main`, title: "Spec from the web modal", purpose: "Created via the in-app agent." },
      actor.user.id,
    );
    const doc = await docFor(out, actor.memexId);
    expect(doc.status).toBe("specify");
  });

  it("the in-app agent never advances phase as a side effect; spec-464 refuses a build-home tool ahead of build, leaving specify put (ac-4; spec-464 ac-8/ac-23)", async () => {
    tagAc(AC(4)); // spec-295: phase is never advanced as a side effect — still true
    // spec-464 supersedes the old "build-class call is accepted but doesn't
    // advance" contract: a build-home tool (update_task) is now REFUSED ahead of
    // build, on the in_app_agent channel identically to mcp.
    tagAc("mindset-prod/memex-building-itself/specs/spec-464/acs/ac-8");
    tagAc("mindset-prod/memex-building-itself/specs/spec-464/acs/ac-23");
    const actor = await setupActor("inapp-no-advance");
    // Create on the web surface → specify.
    const out = await executeServerTool(
      actor.memexId,
      "create_doc",
      { memex: `${actor.nsSlug}/main`, title: "Stays in specify", purpose: "Web-created." },
      actor.user.id,
    );
    const doc = await docFor(out, actor.memexId);
    expect(doc.status).toBe("specify");

    // Seed a task via the ctx-less service (seam-exempt), then drive update_task
    // through the in-app agent: the phase gate refuses it (tasks are build-home),
    // the handler never runs, and the phase stays specify — no side-effect move.
    const seeded = await createTask(actor.memexId, doc.id, "Seeded", "Pre-existing, seam-exempt.");
    await expect(
      executeServerTool(
        actor.memexId,
        "update_task",
        { ref: `${actor.nsSlug}/main/specs/${doc.handle}/tasks/t-${seeded.seq}`, title: "Edited via the in-app agent" },
        actor.user.id,
      ),
    ).rejects.toThrow();
    const after = await db.query.documents.findFirst({ where: eq(documents.id, doc.id) });
    expect(after!.status).toBe("specify");
  });

  it("the mcp channel is unchanged — create_doc still lands in draft (ac-12 asymmetry)", async () => {
    tagAc(AC(12));
    const actor = await setupActor("create-mcp");
    const out = await callMcp(actor.user.id, "create_doc", {
      memex: `${actor.nsSlug}/main`,
      title: "Spec from the coding agent",
      purpose: "Created via MCP.",
    });
    const doc = await docFor(out, actor.memexId);
    expect(doc.status).toBe("draft");
  });
});
