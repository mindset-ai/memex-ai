// spec-464 — the phase gate + the REMOVAL of traffic-driven phase advancement,
// exercised end-to-end through the REAL tool surfaces against Postgres. Every
// case drives a real registered tool (createMcpServer registry for channel
// 'mcp', executeServerTool for channel 'in_app_agent') and asserts the document
// status, doc_assignees row, and doc_members editor row.
//
// The unit-level matrix (every tool × phase cell) lives in
// packages/server/src/services/phase-gate.test.ts; THIS suite pins the
// end-to-end truths that only the real seam can show:
//
//   spec-464 ac-1  — a Spec worked through MCP alone NEVER changes phase as a
//                    side effect; auto-assign + editor promotion still fire.
//   spec-464 ac-2  — an ahead-of-phase agent call is refused through the real
//                    MCP registry (isError, no write, phase unchanged).
//   spec-464 ac-8/15/16/17/22/23 — the flagship cells end-to-end.
//   spec-464 ac-3  — a decision authored on a draft Spec succeeds + carries the
//                    publish nudge, with no phase move.
//
// Auto-assignment (spec-189 dec-6) is a SEPARATE, still-live behaviour spec-464
// did not touch — its cases (ac-5 / ac-10 / ac-11) are retained here.

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
  type SpecTrafficEvent,
} from "../services/spec-traffic.js";
import { bus, type ChangeEvent } from "../services/bus.js";
// The service-layer createTask (no ctx → seam-exempt) seeds a task in any phase
// so the ahead-of-phase update_task / done cases have something to target.
import { createTask } from "../services/tasks.js";
// spec-464 dec-24: the teaching prose the gate composes its refusals/nudges from.
import { PHASE_GATING_CATALOG } from "@memex/shared";

// spec-464 supersedes the spec-189 auto-advance contract; the auto-ASSIGNMENT
// half (spec-189 dec-6) is unchanged and still emits to spec-189 ACs.
const SPEC189 = "mindset-prod/memex-building-itself/specs/spec-189";
const AA = (n: number) => `${SPEC189}/acs/ac-${n}`;
const SPEC464 = "mindset-prod/memex-building-itself/specs/spec-464";
const AC = (n: number) => `${SPEC464}/acs/ac-${n}`;

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

async function taskCount(docId: string): Promise<number> {
  const rows = await db.select().from(tasks).where(eq(tasks.docId, docId));
  return rows.length;
}

// Seed a task via the service layer with NO ctx (seam-exempt) so ahead-of-phase
// update_task / done cases have a real target that the SEAM will then gate.
async function seedTaskRef(spec: { id: string; ref: string }): Promise<string> {
  const t = await createTask(
    actor.memexId,
    spec.id,
    "Pre-existing task",
    "Seeded directly (seam-exempt) to exercise the gate on update_task.",
  );
  return `${spec.ref}/tasks/t-${t.seq}`;
}

describe("spec-464: no traffic-driven phase moves; ahead-of-phase agent calls refused", () => {
  it("a mutating MCP call never moves the Spec's phase; auto-assign + editor still fire; a draft decision carries the publish nudge (ac-1, ac-3)", async () => {
    tagAc(AC(1));
    tagAc(AC(3));
    tagAc(AA(5)); // auto-assignment (spec-189) is unchanged
    tagAc(AA(11)); // auto-editor promotion (spec-189) is unchanged
    const spec = await makeSpec("Draft stays draft");

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

    // spec-464 dec-1: the phase does NOT move as a side effect of the tool call.
    expect(await specStatus(spec.id)).toBe("draft");
    // No auto-advanced status_changed event was emitted for this doc.
    const statusChanged = events.find(
      (e) => e.docId === spec.id && e.action === "status_changed",
    );
    expect(statusChanged).toBeUndefined();
    // dec-3: the response carries the publish→specify nudge (decision recorded).
    expect(res.content[0].text).toContain(PHASE_GATING_CATALOG.draftPlanningNudge);
    // Auto-assign + editor promotion still run (separate behaviour, kept).
    expect(await assigneeIds(spec.id)).toContain(actor.member.id);
    expect(await resolveRole(actor.memexId, spec.id, actor.member.id)).toBe("editor");
  });

  it("in-phase build traffic (update_task on a build Spec) runs and leaves the phase in build (ac-1)", async () => {
    tagAc(AC(1));
    const spec = await makeSpec("Build stays build", "build");
    const taskRef = await seedTaskRef(spec);
    const res = await callMcp(actor.member.id, "update_task", {
      ref: taskRef,
      title: "Implement the fix",
    });
    expect(res.isError).toBeFalsy();
    expect(await specStatus(spec.id)).toBe("build");
    expect(await assigneeIds(spec.id)).toContain(actor.member.id);
  });

  it("task/bridge tools ahead of build are refused end-to-end: no row, no phase change (ac-2, ac-8)", async () => {
    tagAc(AC(2));
    tagAc(AC(8));
    const spec = await makeSpec("create_task refused in specify", "specify");
    const res = await callMcp(actor.member.id, "create_task", {
      ref: spec.ref,
      title: "A thought that should have been a decision",
      description: "…",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(PHASE_GATING_CATALOG.refusals["task:specify"]);
    expect(await taskCount(spec.id)).toBe(0);
    expect(await specStatus(spec.id)).toBe("specify");
  });

  it("write_qa_report is refused before build (ac-15) and runs in build without moving phase (ac-16)", async () => {
    tagAc(AC(15));
    tagAc(AC(16));
    const inSpecify = await makeSpec("qa refused in specify", "specify");
    const refused = await callMcp(actor.member.id, "write_qa_report", {
      ref: inSpecify.ref,
      content: "Nothing built yet.",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain(PHASE_GATING_CATALOG.refusals["qa_report:specify"]);
    expect(await specStatus(inSpecify.id)).toBe("specify");

    const inBuild = await makeSpec("qa runs in build", "build");
    const ok = await callMcp(actor.member.id, "write_qa_report", {
      ref: inBuild.ref,
      content: "## Summary\nWhat this build changed.",
    });
    expect(ok.isError).toBeFalsy();
    expect(await specStatus(inBuild.id)).toBe("build");
  });

  it("a done Spec refuses primitive mutations reopen-first (phase stays done); issues still run (ac-22)", async () => {
    tagAc(AC(22));
    const spec = await makeSpec("done stays done", "done");
    const refused = await callMcp(actor.member.id, "create_decision", {
      ref: spec.ref,
      title: "Post-close decision",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain(PHASE_GATING_CATALOG.doneReopen);
    expect(await specStatus(spec.id)).toBe("done");

    // register_issue is gate-neutral — allowed even on a done Spec.
    const iss = await callMcp(actor.member.id, "register_issue", {
      spec_ref: spec.ref,
      title: "A follow-up",
      body: "Noticed after close.",
      type: "todo",
    });
    expect(iss.isError).toBeFalsy();
    expect(await specStatus(spec.id)).toBe("done");
  });

  it("both agent channels refuse identically: in_app_agent ahead-of-phase throws, no write, phase unchanged (ac-23)", async () => {
    tagAc(AC(23));
    const spec = await makeSpec("in_app_agent refused in specify", "specify");
    await expect(
      executeServerTool(
        actor.memexId,
        "create_task",
        { ref: spec.ref, title: "Should be a decision", description: "…" },
        actor.member.id,
      ),
    ).rejects.toThrow();
    expect(await taskCount(spec.id)).toBe(0);
    expect(await specStatus(spec.id)).toBe("specify");

    // A behind/in-phase in_app_agent call still runs: a decision on a draft Spec
    // succeeds, assigns + promotes, and does not move the phase.
    const draft = await makeSpec("in_app_agent decision on draft");
    const text = await executeServerTool(
      actor.memexId,
      "create_decision",
      { ref: draft.ref, title: "Decision from the in-app agent" },
      actor.member.id,
    );
    expect(text).toBeTruthy();
    expect(await specStatus(draft.id)).toBe("draft");
    expect(await assigneeIds(draft.id)).toContain(actor.member.id);
    expect(await resolveRole(actor.memexId, draft.id, actor.member.id)).toBe("editor");
  });

  it("query-class traffic changes nothing and assigns nobody (ac-5)", async () => {
    tagAc(AA(5));
    const spec = await makeSpec("Query is inert");
    const res = await callMcp(actor.member.id, "get_doc", { ref: spec.ref });
    expect(res.isError).toBeFalsy();
    expect(await specStatus(spec.id)).toBe("draft");
    expect(await assigneeIds(spec.id)).not.toContain(actor.member.id);
    expect(await resolveRole(actor.memexId, spec.id, actor.member.id)).toBe("reviewer");
  });

  it("rest_ui and ctx-less seed calls are NOT phase-gated — the escape valve (ac-2)", async () => {
    tagAc(AC(2));
    // rest_ui: the human web UI keeps full phase controls — createTask via a
    // rest_ui ctx succeeds on a specify Spec (it never routes through the seam).
    const viaRest = await makeSpec("rest_ui create_task allowed", "specify");
    const t1 = await createTask(
      actor.memexId,
      viaRest.id,
      "Human-created task",
      "Via the web UI.",
      undefined,
      undefined,
      { channel: "rest_ui", actorUserId: actor.member.id },
    );
    expect(t1.id).toBeTruthy();
    expect(await taskCount(viaRest.id)).toBe(1);
    expect(await specStatus(viaRest.id)).toBe("specify");

    // no channel (seed/server): fixtures must keep working in any phase.
    const viaSeed = await makeSpec("seed create_task allowed", "draft");
    const t2 = await createTask(actor.memexId, viaSeed.id, "Seeded task", "No ctx.");
    expect(t2.id).toBeTruthy();
    expect(await taskCount(viaSeed.id)).toBe(1);
  });

  it("rest_ui is inert at the observer: no assignment, no phase move (ac-10)", async () => {
    tagAc(AA(10));
    const viaRest = await makeSpec("rest_ui observer inert");
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
    tagAc(AA(5));
    tagAc(AA(11));
    const spec = await makeSpec("Exempt manual tools");

    const res1 = await callMcp(actor.owner.id, "assign_spec", {
      ref: spec.ref,
      user: actor.member.email,
    });
    expect(res1.isError).toBeFalsy();
    expect(await assigneeIds(spec.id)).toContain(actor.member.id);
    expect(await assigneeIds(spec.id)).not.toContain(actor.owner.id);
    expect(await resolveRole(actor.memexId, spec.id, actor.member.id)).toBe("reviewer");

    const res2 = await callMcp(actor.member.id, "unassign_spec", {
      ref: spec.ref,
      user: actor.member.email,
    });
    expect(res2.isError).toBeFalsy();
    expect(await assigneeIds(spec.id)).not.toContain(actor.member.id);
  });

  it("auto-assignment is additive and idempotent: many assignees, repeat traffic adds nothing (ac-5)", async () => {
    tagAc(AA(5));
    const spec = await makeSpec("Multi-assignee");
    // spec-371: rapid cross-user edits collide on the checkout gate unless each
    // user explicitly takes it over first (claim_spec is never gated).
    await callMcp(actor.member.id, "claim_spec", { ref: spec.ref });
    await callMcp(actor.member.id, "create_decision", { ref: spec.ref, title: "One" });
    await callMcp(actor.owner.id, "claim_spec", { ref: spec.ref });
    await callMcp(actor.owner.id, "create_decision", { ref: spec.ref, title: "Two" });
    await callMcp(actor.member.id, "claim_spec", { ref: spec.ref });
    await callMcp(actor.member.id, "create_decision", { ref: spec.ref, title: "Three" });
    const ids = await assigneeIds(spec.id);
    expect(ids).toContain(actor.member.id);
    expect(ids).toContain(actor.owner.id);
    expect(ids.filter((id) => id === actor.member.id)).toHaveLength(1);
    // No phase drift across all that traffic (dec-1).
    expect(await specStatus(spec.id)).toBe("draft");
  });
});
