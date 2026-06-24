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
  type SpecTrafficEvent,
} from "../services/spec-traffic.js";
import { bus, type ChangeEvent } from "../services/bus.js";
// spec-327: create_task is now gated to build; the service-layer createTask
// (no ctx → guard-exempt) is how tests seed a task in any phase, and
// taskCreationBlockedMessage is the shared error string (ac-11).
import { createTask, taskCreationBlockedMessage } from "../services/tasks.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-189";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;
// spec-295 revisits spec-189's traffic contract (dec-2: register_issue is
// non-advancing; dec-3: the in_app_agent channel no longer auto-advances phase).
const SPEC295 = "mindset-prod/memex-building-itself/specs/spec-295";
const SPEC295_AC = (n: number) => `${SPEC295}/acs/ac-${n}`;
// spec-327 revisits spec-189 again: create_task is gated to build and
// reclassified non-advancing, so build-class advancement is exercised via
// update_task on a pre-seeded task.
const SPEC327 = "mindset-prod/memex-building-itself/specs/spec-327";
const SPEC327_AC = (n: number) => `${SPEC327}/acs/ac-${n}`;

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

// spec-327: create_task can no longer be the build-class traffic exemplar (it's
// gated to build + reclassified non-advancing). Seed a task via the service
// layer with NO ctx — channel is undefined, so the agent-channel guard is
// exempt — then drive advancement through update_task (still build-class).
async function seedTaskRef(spec: { id: string; ref: string }): Promise<string> {
  const t = await createTask(
    actor.memexId,
    spec.id,
    "Pre-existing task",
    "Seeded directly (guard-exempt) to exercise build-class update_task traffic.",
  );
  return `${spec.ref}/tasks/t-${t.seq}`;
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

  it("draft + build-class traffic (update_task) → build (ac-1, ac-7)", async () => {
    tagAc(AC(1));
    tagAc(AC(7));
    // spec-327 dec-3 gated create_task to build and reclassified it
    // non-advancing, so the build-class exemplar is now update_task on a
    // pre-seeded task (still trafficClass 'build').
    const spec = await makeSpec("Draft to Build");
    const taskRef = await seedTaskRef(spec);
    const res = await callMcp(actor.member.id, "update_task", {
      ref: taskRef,
      title: "Implement the fix",
    });
    expect(res.isError).toBeFalsy();
    expect(await specStatus(spec.id)).toBe("build");
    expect(await assigneeIds(spec.id)).toContain(actor.member.id);
  });

  // spec-342 SUPERSEDES the former "test_event arriving → verify" behaviour:
  // CI test events no longer drive phase at all (observeTestEventTraffic was
  // removed). The new no-advance contract — a test event leaves a Spec's phase
  // untouched from any source phase, including the old done→verify reopen — is
  // owned by spec-342-test-event-no-advance.integration.test.ts. spec-189 ac-2
  // / ac-7 remain covered here by the build-class / specify-class cases below.

  it("specify + build-class traffic (update_task) → build, even with open decisions (ac-7, ac-8)", async () => {
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

    const taskRef = await seedTaskRef(spec);
    const res = await callMcp(actor.member.id, "update_task", {
      ref: taskRef,
      title: "Implement the thing",
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
    const vTaskRef = await seedTaskRef(inVerify);
    const res2 = await callMcp(actor.member.id, "update_task", {
      ref: vTaskRef,
      title: "Late task edit — build-class traffic on a verify Spec.",
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
    // spec-327 dec-3: create_task is gated to build; use update_task on a
    // pre-seeded task as the build-class reopen trigger.
    const dTaskRef = await seedTaskRef(toBuild);
    const res2 = await callMcp(actor.member.id, "update_task", {
      ref: dTaskRef,
      title: "Fix found after close",
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

  it("in_app_agent assigns + promotes but no longer advances phase (spec-295 dec-3 supersedes spec-189 ac-10's phase parity); rest_ui never triggers", async () => {
    // ASSIGNMENT parity (spec-189 ac-10) is retained — the in-app agent still
    // assigns + promotes the caller exactly like mcp.
    tagAc(AC(10));
    // PHASE NON-advancement on in_app_agent is the new spec-295 contract.
    tagAc(SPEC295_AC(4));
    tagAc(SPEC295_AC(11));
    // in_app_agent: the React agent loop's executeServerTool — same seam.
    const viaAgent = await makeSpec("In-app agent: assign yes, advance no");
    const text = await executeServerTool(
      actor.memexId,
      "create_decision",
      { ref: viaAgent.ref, title: "Decision from the in-app agent" },
      actor.member.id,
    );
    expect(text).toBeTruthy();
    // spec-295 dec-3: phase is human-owned on the web surface — the Spec does
    // NOT auto-advance off draft, even though create_decision is specify-class.
    expect(await specStatus(viaAgent.id)).toBe("draft");
    // …but assignment + editor promotion still happen (they run before the
    // channel-gated phase block, and are independent of trafficClass).
    expect(await assigneeIds(viaAgent.id)).toContain(actor.member.id);
    expect(await resolveRole(actor.memexId, viaAgent.id, actor.member.id)).toBe("editor");

    // mcp on the same input DOES advance (the coding-agent channel keeps it).
    const viaMcp = await makeSpec("mcp still advances");
    const res = await callMcp(actor.member.id, "create_decision", {
      ref: viaMcp.ref,
      title: "Decision from the coding agent",
    });
    expect(res.isError).toBeFalsy();
    expect(await specStatus(viaMcp.id)).toBe("specify");

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

  it("spec-295 dec-2: register_issue is non-advancing — draft stays draft, specify stays specify, but the caller is still assigned (ac-6, ac-10)", async () => {
    tagAc(SPEC295_AC(6));
    tagAc(SPEC295_AC(10));
    // draft: a build-class tool would have advanced to build; register_issue
    // (now trafficClass null) must leave the phase untouched.
    const fromDraft = await makeSpec("Issue on draft stays draft");
    const r1 = await callMcp(actor.member.id, "register_issue", {
      spec_ref: fromDraft.ref,
      title: "Crash on save",
      body: "Repro: save twice.",
      type: "bug",
    });
    expect(r1.isError).toBeFalsy();
    expect(await specStatus(fromDraft.id)).toBe("draft");
    // assignment is independent of trafficClass — the caller is still assigned.
    expect(await assigneeIds(fromDraft.id)).toContain(actor.member.id);

    // specify: would have jumped to build under the old build-class; now stays.
    const fromSpecify = await makeSpec("Issue on specify stays specify", "specify");
    const r2 = await callMcp(actor.member.id, "register_issue", {
      spec_ref: fromSpecify.ref,
      title: "Add a todo",
      body: "Later.",
      type: "todo",
    });
    expect(r2.isError).toBeFalsy();
    expect(await specStatus(fromSpecify.id)).toBe("specify");
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
    const taskRef = await seedTaskRef(spec);
    await db
      .update(documents)
      .set({ pausedAt: new Date() })
      .where(eq(documents.id, spec.id));
    const res = await callMcp(actor.member.id, "update_task", {
      ref: taskRef,
      title: "Edit at a paused Spec — should assign, not move.",
    });
    expect(res.isError).toBeFalsy();
    expect(await specStatus(spec.id)).toBe("draft");
    expect(await assigneeIds(spec.id)).toContain(actor.member.id);
    const row = await db.query.documents.findFirst({ where: eq(documents.id, spec.id) });
    expect(row!.pausedAt).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-327: create_task is gated to the build/verify phases with a guiding error.
//
// A coding agent (mcp / in_app_agent) that calls create_task while the Spec is
// in a PLANNING phase (draft/specify) or is closed (done) is rejected — no task
// row, no phase change — and told to capture the thought as a decision (or a
// todo Issue, or to move the Spec to build). build AND verify are allowed
// (verify is an active phase where a found defect legitimately spawns a task).
// This is the deliberate, narrow exception to the soft-gate posture (dec-4):
// every OTHER agent mutation in a blocked phase is still accepted.
// ──────────────────────────────────────────────────────────────────────────

describe("spec-327: create_task is gated to the build/verify phases", () => {
  async function taskCount(docId: string): Promise<number> {
    const rows = await db.select().from(tasks).where(eq(tasks.docId, docId));
    return rows.length;
  }

  const BLOCKED = ["draft", "specify", "done"] as const;

  it("create_task via mcp in every blocked phase (draft/specify/done) is rejected — no row, no phase change (ac-1, ac-3, ac-7)", async () => {
    tagAc(SPEC327_AC(1));
    tagAc(SPEC327_AC(3));
    tagAc(SPEC327_AC(7));
    for (const phase of BLOCKED) {
      const spec = await makeSpec(`mcp create_task rejected in ${phase}`, phase);
      const res = await callMcp(actor.member.id, "create_task", {
        ref: spec.ref,
        title: "A thought that should have been a decision",
        description: "…",
      });
      expect(res.isError, `create_task should be rejected in ${phase}`).toBe(true);
      expect(await taskCount(spec.id), `no task row in ${phase}`).toBe(0);
      expect(await specStatus(spec.id), `phase unchanged in ${phase}`).toBe(phase);
    }
  });

  it("create_task via in_app_agent in a blocked phase is rejected identically (ac-8)", async () => {
    tagAc(SPEC327_AC(8));
    const spec = await makeSpec("in_app_agent create_task rejected", "specify");
    await expect(
      executeServerTool(
        actor.memexId,
        "create_task",
        { ref: spec.ref, title: "Should be a decision", description: "…" },
        actor.member.id,
      ),
    ).rejects.toThrow(/build or verify/);
    expect(await taskCount(spec.id)).toBe(0);
    expect(await specStatus(spec.id)).toBe("specify");
  });

  it("create_task via rest_ui and via a ctx-less (seed/server) call is NOT blocked (ac-9)", async () => {
    tagAc(SPEC327_AC(9));
    // rest_ui: the human in the web UI keeps full phase controls.
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
    expect(await specStatus(viaRest.id)).toBe("specify"); // rest_ui never advances

    // no channel (seed/server): fixtures must keep working in any phase.
    const viaSeed = await makeSpec("seed create_task allowed", "draft");
    const t2 = await createTask(actor.memexId, viaSeed.id, "Seeded task", "No ctx.");
    expect(t2.id).toBeTruthy();
    expect(await taskCount(viaSeed.id)).toBe(1);
  });

  it("the rejection message names the allowed phases, the current one, and all three remedies, from the shared constant (ac-2, ac-10, ac-11)", async () => {
    tagAc(SPEC327_AC(2));
    tagAc(SPEC327_AC(10));
    tagAc(SPEC327_AC(11));
    const spec = await makeSpec("message contract", "specify");
    const res = await callMcp(actor.member.id, "create_task", {
      ref: spec.ref,
      title: "x",
      description: "y",
    });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    // ac-11: emitted from the shared constant (MCP prefixes "Validation error: ").
    expect(text.startsWith("Validation error:")).toBe(true);
    expect(text).toContain(taskCreationBlockedMessage("specify"));
    // ac-10: names the allowed phases, interpolates the current one, frames the
    // redirect around Decisions + acceptance criteria, names the remedies, and
    // (deliberately) does NOT nudge toward moving the Spec to build.
    expect(text).toContain("build or verify");
    expect(text).toContain("this Spec is in specify");
    expect(text).toContain("Decisions");
    expect(text).toContain("acceptance criteria");
    expect(text).toContain("create_decision");
    expect(text).toContain("register_issue");
    expect(text).not.toContain("update_doc");
  });

  it("create_task works in build AND verify (and leaves the phase put), and updating existing tasks is unaffected (ac-5)", async () => {
    tagAc(SPEC327_AC(5));
    // Both active working phases accept create_task via the agent channel, and
    // (being non-advancing, dec-3) the Spec stays where it is.
    for (const phase of ["build", "verify"] as const) {
      const spec = await makeSpec(`create_task works in ${phase}`, phase);
      const res = await callMcp(actor.member.id, "create_task", {
        ref: spec.ref,
        title: "Real implementation task",
        description: `We're in ${phase}.`,
      });
      expect(res.isError, `create_task should succeed in ${phase}`).toBeFalsy();
      expect(await taskCount(spec.id), `task created in ${phase}`).toBe(1);
      expect(await specStatus(spec.id), `phase unchanged in ${phase}`).toBe(phase);
    }

    // Updating an existing task in a blocked phase is NOT gated (creation-only).
    const inVerify = await makeSpec("update existing task in verify", "verify");
    const taskRef = await seedTaskRef(inVerify);
    const upd = await callMcp(actor.member.id, "update_task", {
      ref: taskRef,
      title: "Edited during verify",
    });
    expect(upd.isError).toBeFalsy();
  });

  it("the carve-out is narrow: create_decision and register_issue on a non-build Spec via mcp still succeed (ac-4, ac-13)", async () => {
    tagAc(SPEC327_AC(4));
    tagAc(SPEC327_AC(13));
    // create_decision on a draft Spec is accepted (specify-class, so it also
    // advances) — proving the server is NOT blocking non-build agent mutations.
    const forDecision = await makeSpec("decision still allowed", "draft");
    const dec = await callMcp(actor.member.id, "create_decision", {
      ref: forDecision.ref,
      title: "A real planning decision",
    });
    expect(dec.isError).toBeFalsy();

    // register_issue is unchanged — raiseable outside build, and non-advancing
    // (spec-202 / spec-295 parking lot intact).
    const forIssue = await makeSpec("issue still allowed in specify", "specify");
    const iss = await callMcp(actor.member.id, "register_issue", {
      spec_ref: forIssue.ref,
      title: "A must-not-forget todo",
      body: "Park it.",
      type: "todo",
    });
    expect(iss.isError).toBeFalsy();
    expect(await specStatus(forIssue.id)).toBe("specify"); // unchanged
  });
});
