// spec-189 t-4 — traffic-driven phase advancement + auto-assignment, exercised
// end-to-end through the REAL tool surfaces against Postgres. Mirrors the
// wiring idiom of spec-roles-tools.integration.test.ts: every case drives a
// real registered tool (createMcpServer registry for channel 'mcp',
// executeServerTool for channel 'in_app_agent') and asserts the resulting
// document status, doc_assignees row, and doc_members editor row — never the
// pure function alone (that matrix is locked in
// packages/shared/src/spec-readiness.traffic.test.ts).
//
// ACs delivered here:
//   ac-1  (scope) — a Spec worked through MCP alone is represented correctly:
//          its phase follows the observed traffic with no web-UI involvement.
//   ac-2  (scope) — the gated rules end-to-end: no verify→build regression,
//          no traffic-driven entry to verify except from draft/done, done
//          reopens per class.
//   ac-5  (scope) — mutating calls assign + promote; query calls never do;
//          multi-assignee, adds-only.
//   ac-8  — transitions are unconditional (open decisions don't gate).
//   ac-10 — channel parity: identical effects for mcp / in_app_agent;
//          rest_ui never triggers.
//   ac-11 — auto-assign also grants editor; manual assign_spec stays
//          role-independent (spec-118 dec-3 preserved on the manual path).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  decisions,
  docAssignees,
  docMembers,
  documents,
  issues,
  memexes,
  namespaces,
  orgMemberships,
  orgs,
  tasks,
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { executeServerTool } from "../agent/tools.js";
import { createDocDraft, updateDocStatus } from "../services/documents.js";
import { listAssignees } from "../services/doc-assignees.js";
import { resolveRole } from "../services/doc-members.js";
import {
  observeSpecTraffic,
  observeTestEventTraffic,
  type SpecTrafficEvent,
} from "../services/spec-traffic.js";
import { bus, type ChangeEvent } from "../services/bus.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-189";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(issues).where(inArray(issues.docId, created.docs)).catch(() => {});
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(docAssignees).where(inArray(docAssignees.docId, created.docs)).catch(() => {});
    await db.delete(docMembers).where(inArray(docMembers.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
});

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}
interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

// Channel 'mcp': through the real createMcpServer registry (the seam wraps
// every registered handler — see mcp/tools.ts).
async function callMcp(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (
    server as unknown as { _registeredTools: Record<string, RegisteredToolLike> }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    .toLowerCase()
    .slice(0, 39);
  const [owner] = await db
    .insert(users)
    .values({ email: `traffic-${sub}@memex.ai` } as typeof users.$inferInsert)
    .returning();
  created.users.push(owner.id);
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: sub, kind: "org" } as typeof namespaces.$inferInsert)
    .returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: `Traffic ${sub}` } as typeof orgs.$inferInsert)
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ name: `Traffic ${sub}`, slug: "main", namespaceId: ns.id } as typeof memexes.$inferInsert)
    .returning();
  created.memexes.push(mx.id);
  await db
    .insert(orgMemberships)
    .values({ userId: owner.id, orgId: org.id, role: "administrator" } as typeof orgMemberships.$inferInsert);

  // A second org member: the MCP/in-app caller whose traffic we observe.
  // Distinct from the creator so assignment/editor rows are unambiguous
  // (createDocDraft seeds the CREATOR as editor).
  const [member] = await db
    .insert(users)
    .values({ email: `traffic-member-${sub}@memex.ai` } as typeof users.$inferInsert)
    .returning();
  created.users.push(member.id);
  await db
    .insert(orgMemberships)
    .values({ userId: member.id, orgId: org.id, role: "member" } as typeof orgMemberships.$inferInsert);

  return { owner, member, slug: ns.slug, memexId: mx.id };
}

let actor: Awaited<ReturnType<typeof setupActor>>;

beforeAll(async () => {
  actor = await setupActor("traffic");
});

async function makeSpec(
  title: string,
  status?: string,
): Promise<{ id: string; ref: string; handle: string }> {
  const doc = await createDocDraft(
    actor.memexId,
    title,
    "purpose",
    "spec",
    undefined,
    undefined,
    actor.owner.id,
  );
  created.docs.push(doc.id);
  if (status && status !== "draft") {
    await updateDocStatus(actor.memexId, doc.id, status);
  }
  return { id: doc.id, ref: `${actor.slug}/main/specs/${doc.handle}`, handle: doc.handle };
}

async function specStatus(id: string): Promise<string> {
  const row = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  return row!.status;
}

async function assigneeIds(id: string): Promise<string[]> {
  return (await listAssignees(actor.memexId, id)).map((a) => a.userId);
}

describe("spec-189: traffic-driven phase advancement through real MCP tool calls", () => {
  it("draft + specify-class traffic (create_decision) → specify, with assignment + editor (ac-1, ac-5, ac-11)", async () => {
    tagAc(AC(1));
    tagAc(AC(5));
    tagAc(AC(11));
    const spec = await makeSpec("Draft to Specify");

    const events: ChangeEvent[] = [];
    const unsub = bus.subscribe(
      { memexId: actor.memexId, entity: "document" },
      (e) => events.push(e),
    );
    let res: ToolResult;
    try {
      res = await callMcp(actor.member.id, "create_decision", {
        ref: spec.ref,
        title: "Which storage engine?",
      });
    } finally {
      unsub();
    }
    expect(res.isError).toBeFalsy();

    // Phase advanced — the board now shows reality with zero web-UI touches.
    expect(await specStatus(spec.id)).toBe("specify");
    // The caller is assigned AND an editor (dec-6) — the creator's seeded
    // editor row is separate; the member's rows are the auto ones.
    expect(await assigneeIds(spec.id)).toContain(actor.member.id);
    expect(await resolveRole(actor.memexId, spec.id, actor.member.id)).toBe("editor");
    // std-8: the status flip emitted a payload-carrying status_changed event
    // whose narrative attributes the AUTO move.
    const statusChanged = events.find(
      (e) => e.docId === spec.id && e.action === "status_changed",
    );
    expect(statusChanged).toBeDefined();
    expect(statusChanged!.narrative).toContain("auto-advanced");
    expect(statusChanged!.payload).toMatchObject({ from: "draft", to: "specify" });
  });

  it("draft + build-class traffic (register_issue) → build (ac-1, ac-7)", async () => {
    tagAc(AC(1));
    tagAc(AC(7));
    const spec = await makeSpec("Draft to Build");
    const res = await callMcp(actor.member.id, "register_issue", {
      spec_ref: spec.ref,
      title: "Crash on save",
      body: "Repro: save twice.",
      type: "bug",
    });
    expect(res.isError).toBeFalsy();
    expect(await specStatus(spec.id)).toBe("build");
    expect(await assigneeIds(spec.id)).toContain(actor.member.id);
  });

  it("draft + verify-class traffic (test_event arriving) → verify; done reopens to verify (ac-2, ac-7)", async () => {
    tagAc(AC(2));
    tagAc(AC(7));
    // Verify-class has no MCP tool (dec-1): it arrives as CI test_events.
    // observeTestEventTraffic is exactly what POST /api/test-events invokes
    // after an accepted, non-hidden emission.
    const fromDraft = await makeSpec("Draft to Verify");
    await observeTestEventTraffic(
      actor.memexId,
      `${actor.slug}/main/specs/${fromDraft.handle}/acs/ac-1`,
    );
    expect(await specStatus(fromDraft.id)).toBe("verify");

    const fromDone = await makeSpec("Done reopens to Verify", "done");
    await observeTestEventTraffic(
      actor.memexId,
      `${actor.slug}/main/specs/${fromDone.handle}/acs/ac-1`,
    );
    expect(await specStatus(fromDone.id)).toBe("verify");
  });

  it("specify + build-class traffic (create_task) → build, even with open decisions (ac-7, ac-8)", async () => {
    tagAc(AC(7));
    tagAc(AC(8));
    const spec = await makeSpec("Specify to Build", "specify");
    // An OPEN decision would fail the assess_spec rubric — the transition is
    // unconditional (dec-3): traffic reflects what's already happening.
    const dec = await callMcp(actor.member.id, "create_decision", {
      ref: spec.ref,
      title: "Open and unresolved",
    });
    expect(dec.isError).toBeFalsy();
    expect(await specStatus(spec.id)).toBe("specify"); // specify-class: stays

    const res = await callMcp(actor.member.id, "create_task", {
      ref: spec.ref,
      title: "Implement the thing",
      description: "Do it.",
    });
    expect(res.isError).toBeFalsy();
    expect(await specStatus(spec.id)).toBe("build");
  });

  it("build + specify-class traffic stays in build; verify never regresses to build (ac-2)", async () => {
    tagAc(AC(2));
    const inBuild = await makeSpec("Build stays on specify traffic", "build");
    const res1 = await callMcp(actor.member.id, "create_decision", {
      ref: inBuild.ref,
      title: "Mid-build decision",
    });
    expect(res1.isError).toBeFalsy();
    expect(await specStatus(inBuild.id)).toBe("build");

    const inVerify = await makeSpec("Verify never regresses", "verify");
    const res2 = await callMcp(actor.member.id, "create_task", {
      ref: inVerify.ref,
      title: "Late task",
      description: "Build-class traffic on a verify Spec.",
    });
    expect(res2.isError).toBeFalsy();
    expect(await specStatus(inVerify.id)).toBe("verify");
  });

  it("done reopens to the traffic's phase: specify-class → specify, build-class → build (ac-2)", async () => {
    tagAc(AC(2));
    const toSpecify = await makeSpec("Done reopens to specify", "done");
    const res1 = await callMcp(actor.member.id, "create_decision", {
      ref: toSpecify.ref,
      title: "Post-done decision",
    });
    expect(res1.isError).toBeFalsy();
    expect(await specStatus(toSpecify.id)).toBe("specify");

    const toBuild = await makeSpec("Done reopens to build", "done");
    const res2 = await callMcp(actor.member.id, "register_issue", {
      spec_ref: toBuild.ref,
      title: "Bug found after close",
      body: "It broke.",
      type: "bug",
    });
    expect(res2.isError).toBeFalsy();
    expect(await specStatus(toBuild.id)).toBe("build");
  });

  it("query-class traffic changes nothing and assigns nobody (ac-5)", async () => {
    tagAc(AC(5));
    const spec = await makeSpec("Query is inert");
    const res = await callMcp(actor.member.id, "get_doc", { ref: spec.ref });
    expect(res.isError).toBeFalsy();
    expect(await specStatus(spec.id)).toBe("draft");
    expect(await assigneeIds(spec.id)).not.toContain(actor.member.id);
    expect(await resolveRole(actor.memexId, spec.id, actor.member.id)).toBe("reviewer");
  });

  it("channel parity: in_app_agent traffic produces identical effects; rest_ui never triggers (ac-10)", async () => {
    tagAc(AC(10));
    // in_app_agent: the React agent loop's executeServerTool — same seam.
    const viaAgent = await makeSpec("In-app agent parity");
    const text = await executeServerTool(
      actor.memexId,
      "create_decision",
      { ref: viaAgent.ref, title: "Decision from the in-app agent" },
      actor.member.id,
    );
    expect(text).toBeTruthy();
    expect(await specStatus(viaAgent.id)).toBe("specify");
    expect(await assigneeIds(viaAgent.id)).toContain(actor.member.id);
    expect(await resolveRole(actor.memexId, viaAgent.id, actor.member.id)).toBe("editor");

    // rest_ui: structurally excluded (REST routes never pass the seam), and
    // the observer itself refuses the channel even if handed one.
    const viaRest = await makeSpec("rest_ui is inert");
    await observeSpecTraffic({
      toolName: "create_decision",
      channel: "rest_ui",
      userId: actor.member.id,
      memexId: actor.memexId,
      docId: viaRest.id,
    } as unknown as SpecTrafficEvent);
    expect(await specStatus(viaRest.id)).toBe("draft");
    expect(await assigneeIds(viaRest.id)).not.toContain(actor.member.id);
  });

  it("manual assignment tools are exempt: unassign_spec(self) sticks, assign_spec grants no editor row (ac-5, ac-11)", async () => {
    tagAc(AC(5));
    tagAc(AC(11));
    const spec = await makeSpec("Exempt manual tools");

    // Manual assign of the member by the owner: assignment lands, but the
    // manual path stays role-independent (spec-118 dec-3) — no editor row —
    // and the OWNER (the mutating caller) is not auto-assigned either.
    const res1 = await callMcp(actor.owner.id, "assign_spec", {
      ref: spec.ref,
      user: actor.member.email,
    });
    expect(res1.isError).toBeFalsy();
    expect(await assigneeIds(spec.id)).toContain(actor.member.id);
    expect(await assigneeIds(spec.id)).not.toContain(actor.owner.id);
    expect(await resolveRole(actor.memexId, spec.id, actor.member.id)).toBe("reviewer");

    // unassign_spec(self) must not instantly undo itself via auto-assignment.
    const res2 = await callMcp(actor.member.id, "unassign_spec", {
      ref: spec.ref,
      user: actor.member.email,
    });
    expect(res2.isError).toBeFalsy();
    expect(await assigneeIds(spec.id)).not.toContain(actor.member.id);
  });

  it("auto-assignment is additive and idempotent: many assignees, repeat traffic adds nothing (ac-5)", async () => {
    tagAc(AC(5));
    const spec = await makeSpec("Multi-assignee");
    await callMcp(actor.member.id, "create_decision", { ref: spec.ref, title: "One" });
    await callMcp(actor.owner.id, "create_decision", { ref: spec.ref, title: "Two" });
    await callMcp(actor.member.id, "create_decision", { ref: spec.ref, title: "Three" });
    const ids = await assigneeIds(spec.id);
    expect(ids).toContain(actor.member.id);
    expect(ids).toContain(actor.owner.id);
    expect(ids.filter((id) => id === actor.member.id)).toHaveLength(1);
  });

  it("paused Specs still assign but never auto-transition; hidden-style flags stay untouched", async () => {
    const spec = await makeSpec("Paused stays put");
    await db
      .update(documents)
      .set({ pausedAt: new Date() })
      .where(eq(documents.id, spec.id));
    const res = await callMcp(actor.member.id, "create_task", {
      ref: spec.ref,
      title: "Task at a paused Spec",
      description: "Should assign, not move.",
    });
    expect(res.isError).toBeFalsy();
    expect(await specStatus(spec.id)).toBe("draft");
    expect(await assigneeIds(spec.id)).toContain(actor.member.id);
    const row = await db.query.documents.findFirst({ where: eq(documents.id, spec.id) });
    expect(row!.pausedAt).not.toBeNull();
  });
});
