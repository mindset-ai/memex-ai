// Integration tests for the Spec MCP tools (formerly Mission/Brief) — post
// doc-14 t-7 migration and b-105 Brief → Spec rename. Goes through the real
// createMcpServer registry against a real Postgres — exercises the service-
// layer wiring that the unit tests in tools.test.ts can't because they mock
// everything.
//
// After doc-14 the type-specific tools collapsed into the generic
// doc/task/decision tools. The describe blocks use the current Spec
// vocabulary; call-sites are the post-doc-14 generic tools plus the named
// Spec lifecycle verbs (assess_spec / publish_spec).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
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
  mcpSessions,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { createDocDraft, updateDocStatus } from "../services/documents.js";
import { createTask } from "../services/tasks.js";
import { _clearRecentAssessments } from "../services/phase-assessment.js";
import { _clearHandoffDeliveries } from "../services/handoff-delivery.js";
import { tagAc } from "@memex-ai-ac/vitest";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (created.docs.length) {
    await db
      .delete(tasks)
      .where(inArray(tasks.docId, created.docs))
      .catch(() => {});
    await db
      .delete(decisions)
      .where(inArray(decisions.docId, created.docs))
      .catch(() => {});
    await db
      .delete(documents)
      .where(inArray(documents.id, created.docs))
      .catch(() => {});
  }
  if (created.memexes.length) {
    await db
      .delete(memexes)
      .where(inArray(memexes.id, created.memexes))
      .catch(() => {});
  }
  if (created.users.length) {
    await db
      .delete(users)
      .where(inArray(users.id, created.users))
      .catch(() => {});
  }
});

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase().slice(0, 39);
  const [u] = await db
    .insert(users)
    .values({
      email: `mcp-spec-${sub}@memex.ai`,
    } as any)
    .returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" } as any).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` } as any).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db
    .insert(memexes)
    .values({ name: `Test ${sub}`, slug: "main", namespaceId: ns.id } as any)
    .returning();
  created.memexes.push(a.id);
  await db
    .insert(orgMemberships)
    .values({ userId: u.id, orgId: org.id, role: "administrator" } as any);
  return { user: u, account: { ...a, slug: ns.slug } };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

async function callTool(
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
  // Minimal "extra" — the Spec tools don't read sessionId / signal / _meta.
  // Per dec-1 of doc-20 the MCP surface defaults to terse output. These pre-
  // doc-20 tests assert against the verbose markdown surface, so opt in via
  // the documented `verbose: true` escape hatch unless the test sets it
  // explicitly.
  const withVerbose = "verbose" in args ? args : { ...args, verbose: true };
  return await tool.handler(withVerbose, {} as unknown);
}

let actor: Awaited<ReturnType<typeof setupActor>>;

beforeAll(async () => {
  actor = await setupActor("spec");
});

describe("Spec MCP tools (post-doc-14, b-105)", () => {
  it("registers the consolidated Spec-related tools", () => {
    const server = createMcpServer(actor.user.id);
    const names = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    // Spec lifecycle entry-points kept as named verbs (post b-105 rename).
    expect(names).toContain("publish_spec");
    expect(names).toContain("assess_spec");
    // Generic doc/decision/task tools handle the rest of the Spec surface.
    expect(names).toContain("list_docs");
    expect(names).toContain("get_doc");
    expect(names).toContain("create_doc");
    expect(names).toContain("update_doc");
    expect(names).toContain("update_section");
    expect(names).toContain("create_decision");
    expect(names).toContain("create_task");
  });

  it("create_doc creates a Spec doc (docType='spec')", async () => {
    const result = await callTool(actor.user.id, "create_doc", {
      memex: `${actor.account.slug}/main`,
      title: "MCP Spec A",
      purpose: "Why we exist",
      docType: "spec",
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("MCP Spec A");
    expect(text).toContain("Type: spec");
    expect(text).toContain("[DRAFT]");

    const doc = await db.query.documents.findFirst({
      where: eq(documents.title, "MCP Spec A"),
    });
    expect(doc).toBeDefined();
    expect(doc!.docType).toBe("spec");
    expect(doc!.memexId).toBe(actor.account.id);
    created.docs.push(doc!.id);
  });

  it("list_docs returns only Spec-typed docs (every phase, spec-521 dec-3)", async () => {
    // Seed a non-Spec doc to verify docType filtering.
    const freeDoc = await createDocDraft(actor.account.id, "A free doc", "purpose", "document");
    created.docs.push(freeDoc.id);
    // spec-521 dec-3: the DRAFT exclusion this test used to assert is gone — draft
    // Specs are now in the default set, so `MCP Spec A` (draft, from the earlier test)
    // is legitimately present. The docType filter is what this test is actually about,
    // and that is unchanged.
    const active = await createDocDraft(actor.account.id, "Active Spec Vis", "P", "spec");
    created.docs.push(active.id);
    await updateDocStatus(actor.account.id, active.id, "specify");

    const result = await callTool(actor.user.id, "list_docs", {
      memex: `${actor.account.slug}/main`,
      docType: "spec",
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // formatSpecList leads with "# Specs (<n>)".
    expect(text).toContain("# Specs");
    expect(text).toContain("Active Spec Vis");
    // Non-Specs filtered — the actual subject of this test.
    expect(text).not.toContain("A free doc");
    // And the draft Spec is now INCLUDED, which is the dec-3 change.
    expect(text).toContain("MCP Spec A");
  });

  it("get_spec_draft returns full Spec state (via get_doc)", async () => {
    const doc = await createDocDraft(actor.account.id, "GetDraft Spec", "P", "spec");
    created.docs.push(doc.id);
    const result = await callTool(actor.user.id, "get_doc", {
      ref: `${actor.account.slug}/main/specs/${doc.handle}`,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("GetDraft Spec");
  });

  // Post doc-14: get_doc is generic — non-Spec docs simply return their state
  // rather than erroring. Spec-only validation now happens at the named-verb
  // boundary (publish_spec / assess_spec).

  it("update_spec_draft updates a section content (via update_section)", async () => {
    const doc = await createDocDraft(actor.account.id, "UpdateDraft", "Original purpose", "spec");
    created.docs.push(doc.id);
    const section = doc.sections[0];
    const result = await callTool(actor.user.id, "update_section", {
      ref: `${actor.account.slug}/main/specs/${doc.handle}/sections/s-${section.seq}`,
      content: "Refined purpose",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Refined purpose");
  });

  it("add_draft_decision creates an open decision (via create_decision)", async () => {
    const doc = await createDocDraft(actor.account.id, "DecsDraft", "P", "spec");
    created.docs.push(doc.id);
    const result = await callTool(actor.user.id, "create_decision", {
      ref: `${actor.account.slug}/main/specs/${doc.handle}`,
      title: "Cache layer?",
      context: "A vs B",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Cache layer?");

    const decs = await db.query.decisions.findMany({
      where: eq(decisions.docId, doc.id),
    });
    expect(decs).toHaveLength(1);
    expect(decs[0].status).toBe("open");
  });

  it("add_draft_task creates a task (via create_task)", async () => {
    const doc = await createDocDraft(actor.account.id, "ItemsDraft", "P", "spec");
    created.docs.push(doc.id);
    // spec-327: create_task is gated to the build phase.
    await updateDocStatus(actor.account.id, doc.id, "build");
    const result = await callTool(actor.user.id, "create_task", {
      ref: `${actor.account.slug}/main/specs/${doc.handle}`,
      title: "Implement A",
      description: "Build the A subsystem",
      acceptanceCriteria: [{ description: "Tests pass", done: false }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Implement A");

    const items = await db.query.tasks.findMany({
      where: eq(tasks.docId, doc.id),
    });
    expect(items).toHaveLength(1);
  });

  it("publish_spec moves a draft Spec to specify (default)", async () => {
    // spec-181 ac-10: publish_spec lands a draft Spec on status='specify' by
    // default. Per dec-3 / dec-1 of doc-10 the default target flipped from
    // `review` to `plan`, then spec-181 renamed that phase plan→specify.
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-10");
    const doc = await createDocDraft(actor.account.id, "PublishMe", "P", "spec");
    created.docs.push(doc.id);
    const result = await callTool(actor.user.id, "publish_spec", {
      ref: `${actor.account.slug}/main/specs/${doc.handle}`,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("[SPECIFY]");

    const reload = await db.query.documents.findFirst({
      where: eq(documents.id, doc.id),
    });
    expect(reload!.status).toBe("specify");
  });

  it("publish_spec refuses already-published Specs", async () => {
    const doc = await createDocDraft(actor.account.id, "AlreadyPublished", "P", "spec");
    created.docs.push(doc.id);
    const ref = `${actor.account.slug}/main/specs/${doc.handle}`;
    await callTool(actor.user.id, "publish_spec", { ref });
    const second = await callTool(actor.user.id, "publish_spec", { ref });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/already published/);
  });

  it("get_spec_status reports counts and lineage (via get_doc)", async () => {
    const doc = await createDocDraft(actor.account.id, "StatusOne", "P", "spec");
    created.docs.push(doc.id);
    const ref = `${actor.account.slug}/main/specs/${doc.handle}`;
    await callTool(actor.user.id, "create_decision", {
      ref,
      title: "Q?",
    });
    // spec-189: create_decision auto-advanced the draft Spec → specify.
    // spec-327: create_task no longer drives specify → build (it's gated to the
    // build phase), so enter build explicitly before creating the task.
    await updateDocStatus(actor.account.id, doc.id, "build");
    await callTool(actor.user.id, "create_task", {
      ref,
      title: "Build it",
      description: "...",
    });
    const result = await callTool(actor.user.id, "get_doc", { ref });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // The doc state now reports the build phase + the decision/task counts.
    expect(text).toContain("# StatusOne [BUILD]");
    // formatFullDocState now emits "## Decisions (1 total: …)" / "## Tasks (1 total: …)".
    expect(text).toMatch(/Decisions \(1/);
    expect(text).toMatch(/Tasks \(1/);
  });

  it("promote_task creates a new Spec linked to the source (via create_doc)", async () => {
    const source = await createDocDraft(actor.account.id, "Source Spec", "P", "spec");
    created.docs.push(source.id);
    const item = await createTask(
      actor.account.id,
      source.id,
      "Big chunk of work",
      "Description",
    );
    const result = await callTool(actor.user.id, "create_doc", {
      docType: "spec",
      promoteFromTaskRef: `${actor.account.slug}/main/specs/${source.handle}/tasks/t-${item.seq}`,
      title: "Promoted Spec",
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("Promoted Spec");
    expect(text).toContain("Source Spec");

    const newSpec = await db.query.documents.findFirst({
      where: eq(documents.title, "Promoted Spec"),
    });
    expect(newSpec).toBeDefined();
    expect(newSpec!.parentDocId).toBe(source.id);
    // promoteToBrief writes docType='spec' (canonical name post-b-105).
    expect(newSpec!.docType).toBe("spec");
    created.docs.push(newSpec!.id);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Doc-12 t-6 lifecycle nudges (no hard blocks; soft guidance only)
// ──────────────────────────────────────────────────────────────────────────────

describe("MCP lifecycle nudges (doc-12 t-6)", () => {
  beforeAll(() => _clearRecentAssessments());

  // Helper: build a canonical ref for a doc within the actor's memex.
  // Free-form docs live under `/docs/`, Specs under `/specs/`.
  function refFor(doc: { docType: string; handle: string }): string {
    const docTypeUrl =
      doc.docType === "spec"
        ? "specs"
        : doc.docType === "standard"
          ? "standards"
          : doc.docType === "execution_plan"
            ? "execution-plans"
            : "docs";
    return `${actor.account.slug}/main/${docTypeUrl}/${doc.handle}`;
  }

  it("update_doc with status=done succeeds (no hard block)", async () => {
    const m = await createDocDraft(actor.account.id, "DoneSucceeds", "P", "spec");
    created.docs.push(m.id);
    // Walk to verify so verify→done is the active transition.
    await updateDocStatus(actor.account.id, m.id, "verify");

    const result = await callTool(actor.user.id, "update_doc", {
      ref: refFor(m),
      status: "done",
    });
    expect(result.isError).toBeFalsy();
    const reload = await db.query.documents.findFirst({
      where: eq(documents.id, m.id),
    });
    expect(reload!.status).toBe("done");
  });

  it("update_doc verify→done delivers the done orientation", async () => {
    _clearRecentAssessments();
    const m = await createDocDraft(actor.account.id, "DoneWarn", "P", "spec");
    created.docs.push(m.id);
    await updateDocStatus(actor.account.id, m.id, "verify");

    const result = await callTool(actor.user.id, "update_doc", {
      ref: refFor(m),
      status: "done",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("This spec is now done");
  });

  it("update_doc verify→done emits NO warning when assess was recent", async () => {
    _clearRecentAssessments();
    const m = await createDocDraft(actor.account.id, "DoneNoWarn", "P", "spec");
    created.docs.push(m.id);
    await updateDocStatus(actor.account.id, m.id, "verify");

    // Prime the recency cache by calling assess_spec(mode='phase') first.
    const assessed = await callTool(actor.user.id, "assess_spec", {
      ref: refFor(m),
      mode: "phase",
      target: "done",
    });
    expect(assessed.isError).toBeFalsy();

    const result = await callTool(actor.user.id, "update_doc", {
      ref: refFor(m),
      status: "done",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("Strongly recommend");
    expect(result.content[0].text).not.toContain("ℹ Tip");
  });

  it("publish_spec with status=done succeeds + warning when no recent assess", async () => {
    _clearRecentAssessments();
    const m = await createDocDraft(actor.account.id, "PublishDone", "P", "spec");
    created.docs.push(m.id);

    const result = await callTool(actor.user.id, "publish_spec", {
      ref: refFor(m),
      status: "done",
    });
    expect(result.isError).toBeFalsy();
    // draft→done is forward but isn't one of the rubric'd transitions
    // (specify→build, build→verify, verify→done). The nudge fires only on those.
    // Confirm the publish succeeded without a hard block — that's the t-6 lift.
    const reload = await db.query.documents.findFirst({ where: eq(documents.id, m.id) });
    expect(reload!.status).toBe("done");
  });

  it("forward specify→build delivers the build orientation", async () => {
    _clearRecentAssessments();
    const m = await createDocDraft(actor.account.id, "PlanBuildNudge", "P", "spec");
    created.docs.push(m.id);
    await updateDocStatus(actor.account.id, m.id, "specify");

    const result = await callTool(actor.user.id, "update_doc", {
      ref: refFor(m),
      status: "build",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("You are now in build.");
    expect(result.content[0].text).not.toContain("ℹ Tip");
  });

  it("backward transitions (build→specify) get NO nudge", async () => {
    _clearRecentAssessments();
    const m = await createDocDraft(actor.account.id, "Backward", "P", "spec");
    created.docs.push(m.id);
    await updateDocStatus(actor.account.id, m.id, "build");

    const result = await callTool(actor.user.id, "update_doc", {
      ref: refFor(m),
      status: "specify",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("ℹ Tip");
    expect(result.content[0].text).not.toContain("Strongly recommend");
  });

  it("non-Spec docs don't get a nudge on forward transitions", async () => {
    _clearRecentAssessments();
    // Use canonical docType='document' so the ref resolves through the
    // /docs/ URL grammar.
    const freeDoc = await createDocDraft(actor.account.id, "FreeDocNoNudge", "P", "document");
    created.docs.push(freeDoc.id);

    // Generic doc lifecycle — review is a legacy status, but no rubric exists
    // for non-Spec docs. The nudge logic gates on docType.
    const result = await callTool(actor.user.id, "update_doc", {
      ref: refFor(freeDoc),
      status: "review",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("ℹ Tip");
    expect(result.content[0].text).not.toContain("Strongly recommend");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Doc-12 t-15 list_specs filters archived / draft / done
// ──────────────────────────────────────────────────────────────────────────────

describe("list_specs active-only filter (doc-12 t-15)", () => {
  // spec-521 dec-3 REVERSED this contract, deliberately. The old assertion was
  // "excludes draft / done / archived; keeps specify / build / verify" — and the
  // draft/done half of that exclusion was the DEFECT: it silently dropped every draft
  // Spec, so a tag-shaped question got a wrong answer that looked right. Archived is
  // now the ONLY exclusion, and the header states what it withheld. The test is
  // rewritten to the new contract rather than deleted, so the coverage survives the
  // change of intent.
  it("returns every phase EXCEPT archived, and states what it withheld (spec-521 dec-3)", async () => {
    const sub = `t15-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 39);
    const [u] = await db
      .insert(users)
      .values({ email: `t15-${sub}@memex.ai` } as any)
      .returning();
    created.users.push(u.id);
    const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" } as any).returning();
    const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `T15 ${sub}` } as any).returning();
    await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    const [a0] = await db
      .insert(memexes)
      .values({ name: `T15 ${sub}`, slug: "main", namespaceId: ns.id } as any)
      .returning();
    created.memexes.push(a0.id);
    await db
      .insert(orgMemberships)
      .values({ userId: u.id, orgId: org.id, role: "administrator" } as any);
    const a = { ...a0, slug: ns.slug };

    // Seed one Spec per state.
    const draftM = await createDocDraft(a.id, "DraftSpec", "P", "spec");
    created.docs.push(draftM.id);

    const planM = await createDocDraft(a.id, "PlanSpec", "P", "spec");
    created.docs.push(planM.id);
    await updateDocStatus(a.id, planM.id, "specify");

    const buildM = await createDocDraft(a.id, "BuildSpec", "P", "spec");
    created.docs.push(buildM.id);
    await updateDocStatus(a.id, buildM.id, "build");

    const verifyM = await createDocDraft(a.id, "VerifySpec", "P", "spec");
    created.docs.push(verifyM.id);
    await updateDocStatus(a.id, verifyM.id, "verify");

    const doneM = await createDocDraft(a.id, "DoneSpec", "P", "spec");
    created.docs.push(doneM.id);
    await updateDocStatus(a.id, doneM.id, "done");

    const archivedM = await createDocDraft(a.id, "ArchivedSpec", "P", "spec");
    created.docs.push(archivedM.id);
    await db
      .update(documents)
      .set({ archivedAt: new Date() })
      .where(eq(documents.id, archivedM.id));

    const result = await callTool(u.id, "list_docs", {
      memex: `${a.slug}/main`,
      docType: "spec",
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;

    // Every phase is in — draft and done included (ac-6).
    expect(text).toContain("DraftSpec");
    expect(text).toContain("PlanSpec");
    expect(text).toContain("BuildSpec");
    expect(text).toContain("VerifySpec");
    expect(text).toContain("DoneSpec");
    // Archived is the ONLY exclusion.
    expect(text).not.toContain("ArchivedSpec");
    // ac-8: and the response SAYS it withheld one, rather than hiding a row in
    // silence — 5 shown of 6, 1 archived.
    const header = text.split("\n")[0];
    expect(header).toContain("5 of 6");
    expect(header).toContain("1 archived, hidden");

    // statusIn narrows back to the old active set for a caller that wants it — the
    // capability the hardcoded whitelist used to impose.
    const narrowed = await callTool(u.id, "list_docs", {
      memex: `${a.slug}/main`,
      docType: "spec",
      statusIn: ["specify", "build", "verify"],
    });
    const narrowedText = narrowed.content[0].text;
    expect(narrowedText).toContain("PlanSpec");
    expect(narrowedText).not.toContain("DraftSpec");
    expect(narrowedText).not.toContain("DoneSpec");
    expect(narrowedText).not.toContain("ArchivedSpec");
    expect(narrowedText.split("\n")[0]).toContain("outside statusIn");
  });
});

// spec-203 Layer 2 (dec-2) ac-10: the end-to-end delivery decision through the
// real createMcpServer dispatch — proves session_id is threaded from dispatch
// into ctx and the footer delivers the FULL handoff once per (session, spec,
// phase) then the essence, re-delivering for a new session.
const AC203 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-203/acs/ac-${n}`;

async function callToolWithSession(
  userId: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = createMcpServer(userId, undefined, sessionId);
  const registry = (
    server as unknown as { _registeredTools: Record<string, RegisteredToolLike> }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const withVerbose = "verbose" in args ? args : { ...args, verbose: true };
  return await tool.handler(withVerbose, {} as unknown);
}

describe("phase handoff full-vs-essence delivery (spec-203 Layer 2, ac-10)", () => {
  // Static opening of the full handoff prompt + a STEP-1 detail that lives ONLY
  // in the full text, never in the compressed essence.
  const FULL_MARKER = "You are working in Memex";
  const FULL_ONLY = "minting them is your job";
  const ESSENCE_MARKER = 'You are now in build.';

  let buildSpecRef: string;

  beforeAll(async () => {
    _clearHandoffDeliveries();
    const doc = await createDocDraft(actor.account.id, "HandoffDelivery Spec", "P", "spec");
    created.docs.push(doc.id);
    // Drop straight to build so the footer carries the build handoff (the test
    // exercises the delivery machine, not the specify→build gate).
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
    // Seed the MCP sessions so the error-swallowing tool-call telemetry insert
    // (which FK-references mcp_sessions) stays quiet during the test.
    await db
      .insert(mcpSessions)
      .values([
        { sessionId: "handoff-sess-A", userId: actor.user.id },
        { sessionId: "handoff-sess-B", userId: actor.user.id },
      ])
      .onConflictDoNothing();
    buildSpecRef = `${actor.account.slug}/main/specs/${doc.handle}`;
  });

  it("delivers the FULL handoff on the first response of a session+phase, the essence after", async () => {
    tagAc(AC203(10));
    // Scope outcomes this end-to-end run also proves: a chat-driven agent gets
    // the handoff in the footer (ac-1), and full-once-then-essence (ac-3).
    tagAc(AC203(1));
    tagAc(AC203(3));
    const first = await callToolWithSession(actor.user.id, "handoff-sess-A", "get_doc", {
      ref: buildSpecRef,
    });
    const firstText = first.content[0].text;
    expect(firstText).toContain(FULL_MARKER);
    expect(firstText).toContain(FULL_ONLY);
    expect(firstText).not.toContain(ESSENCE_MARKER);

    const second = await callToolWithSession(actor.user.id, "handoff-sess-A", "get_doc", {
      ref: buildSpecRef,
    });
    const secondText = second.content[0].text;
    expect(secondText).toContain(ESSENCE_MARKER);
    expect(secondText).not.toContain(FULL_MARKER);
  });

  it("re-delivers the FULL handoff for a different session", async () => {
    tagAc(AC203(10));
    const fresh = await callToolWithSession(actor.user.id, "handoff-sess-B", "get_doc", {
      ref: buildSpecRef,
    });
    expect(fresh.content[0].text).toContain(FULL_MARKER);
  });

  // ── spec-510 t-3: the cadence itself ──────────────────────────────────────
  //
  // Driven through a REAL tool call rather than a unit test on the helper: the
  // claim this task makes is about what an agent RECEIVES, and a helper test
  // would pass just as well with the seat never wired to it.
  //
  // `callToolWithSession` sends `verbose: true`, which is the path that carries
  // the static guidance at all — the terse build-loop footer is the handoff
  // essence plus dynamic state and never had toNudge prose in it (spec-219
  // Phase 2b). So the cadence's reach is verbose reads, and these tests say so
  // by construction.
  const STATIC_MARKER = "classify-and-consult"; // the tripwire block, a toNudge block
  const POINTER = "guidance shown earlier this session";

  it("emits static guidance in full on first sight, a pointer thereafter (ac-9, ac-12)", async () => {
    tagAc(`mindset-prod/memex-building-itself/specs/spec-510/acs/ac-9`);
    tagAc(`mindset-prod/memex-building-itself/specs/spec-510/acs/ac-12`);
    process.env.GUIDANCE_CADENCE_ENABLED = "true";
    const sessionId = "cadence-sess-A";
    try {
      await db.insert(mcpSessions).values([{ sessionId, userId: actor.user.id }]).onConflictDoNothing();

      const first = await callToolWithSession(actor.user.id, sessionId, "get_doc", {
        ref: buildSpecRef,
      });
      const firstText = first.content[0].text;
      expect(firstText).toContain(STATIC_MARKER);
      expect(firstText).not.toContain(POINTER);

      const second = await callToolWithSession(actor.user.id, sessionId, "get_doc", {
        ref: buildSpecRef,
      });
      const secondText = second.content[0].text;
      // The prose the agent already read is gone…
      expect(secondText).not.toContain(STATIC_MARKER);
      // …replaced by ONE line that NAMES the way back. The Design & UX lens is
      // explicit that this must read as a reference, not a fault.
      expect(secondText).toContain(POINTER);
      expect(secondText).not.toMatch(/⚠|omitted|truncated/);

      // The point of the whole Spec: the second response is materially smaller.
      expect(secondText.length).toBeLessThan(firstText.length);
    } finally {
      delete process.env.GUIDANCE_CADENCE_ENABLED;
    }
  });

  it("NEVER suppresses the dynamic state line (ac-2)", async () => {
    tagAc(`mindset-prod/memex-building-itself/specs/spec-510/acs/ac-9`);
    process.env.GUIDANCE_CADENCE_ENABLED = "true";
    const sessionId = "cadence-sess-B";
    try {
      await db.insert(mcpSessions).values([{ sessionId, userId: actor.user.id }]).onConflictDoNothing();
      const a = await callToolWithSession(actor.user.id, sessionId, "get_doc", { ref: buildSpecRef });
      const b = await callToolWithSession(actor.user.id, sessionId, "get_doc", { ref: buildSpecRef });
      // The dynamic half is composed separately from the suppressed blocks and
      // must survive on EVERY response — it is the part that changes per call
      // and actually steers. Note it takes its two legitimate FORMS here: the
      // full handoff on the group's first response (spec-203), the compressed
      // essence thereafter. Asserting one marker on both would be wrong, and
      // getting that wrong is how this test first failed.
      expect(a.content[0].text).toContain(FULL_MARKER);
      expect(b.content[0].text).toContain(ESSENCE_MARKER);
      // …and the suppression applies to the STATIC half only.
      expect(a.content[0].text).toContain(STATIC_MARKER);
      expect(b.content[0].text).not.toContain(STATIC_MARKER);
      expect(b.content[0].text).toContain(POINTER);
    } finally {
      delete process.env.GUIDANCE_CADENCE_ENABLED;
    }
  });

  it("with the flag OFF the second response is byte-identical to the first (the retreat path)", async () => {
    tagAc(`mindset-prod/memex-building-itself/specs/spec-510/acs/ac-9`);
    // ac-7 (scope): "switching it off restores the previous emission behaviour
    // EXACTLY". This is the test that says what "exactly" means; the other half
    // of ac-7 — that switching off needs no deploy — is the flag being read live
    // plus it actually reaching the service, which t-7's passthrough guard pins.
    tagAc(`mindset-prod/memex-building-itself/specs/spec-510/acs/ac-7`);
    delete process.env.GUIDANCE_CADENCE_ENABLED;
    const sessionId = "cadence-sess-off";
    await db.insert(mcpSessions).values([{ sessionId, userId: actor.user.id }]).onConflictDoNothing();
    const a = await callToolWithSession(actor.user.id, sessionId, "get_doc", { ref: buildSpecRef });
    const b = await callToolWithSession(actor.user.id, sessionId, "get_doc", { ref: buildSpecRef });
    // The STATIC half must be the same on both calls — that is what makes the
    // kill switch a real retreat rather than a different behaviour.
    expect(b.content[0].text).toContain(STATIC_MARKER);
    expect(b.content[0].text).not.toContain(POINTER);

    // ⚠ THE WHOLE RESPONSE IS NOT BYTE-IDENTICAL, AND MUST NOT BE ASSERTED SO.
    // An earlier version of this comment said "the guidance half must be the
    // SAME BYTES", which reads as a claim about the response; tightening the
    // assertion to `b === a` reds it. The difference is spec-203 Layer 2 and
    // predates this Spec entirely: call one carries the FULL phase handoff,
    // call two its essence. So the two responses legitimately differ in the
    // dynamic half whatever the cadence flag says.
    //
    // What ac-7 actually promises is that flipping the flag off restores the
    // behaviour that existed BEFORE spec-510 — asserted as the static guidance
    // surviving both calls, above. Comparing the two calls to each other tests
    // spec-203, not this flag.
    expect(a.content[0].text).toContain(STATIC_MARKER);
    expect(a.content[0].text).not.toContain(POINTER);
  });

  it("a session with no cadence key gets full guidance every time (the no-key fallback)", async () => {
    tagAc(`mindset-prod/memex-building-itself/specs/spec-510/acs/ac-9`);
    process.env.GUIDANCE_CADENCE_ENABLED = "true";
    try {
      // Two DIFFERENT sessions stand in for the stateless path: no shared key,
      // so nothing can be suppressed. This is also the first call of every real
      // conversation, which must never be degraded.
      const one = await callToolWithSession(actor.user.id, "handoff-sess-A", "get_doc", {
        ref: buildSpecRef,
      });
      const two = await callToolWithSession(actor.user.id, "handoff-sess-B", "get_doc", {
        ref: buildSpecRef,
      });
      expect(one.content[0].text).toContain(STATIC_MARKER);
      expect(two.content[0].text).toContain(STATIC_MARKER);
    } finally {
      delete process.env.GUIDANCE_CADENCE_ENABLED;
    }
  });

  // spec-510 t-4 — the claim became ASYNC, and the one way to get that wrong is
  // to await it OUTSIDE the `&&` chain that guards it. Nothing else in the suite
  // would notice: the response is identical either way.
  it("does NOT consume a claim on a phase that has no handoff at all", async () => {
    tagAc(`mindset-prod/memex-building-itself/specs/spec-510/acs/ac-19`);
    process.env.HANDOFF_SHARED_STORE_ENABLED = "true";
    const sessionId = "handoff-sess-draft";
    try {
      await db
        .insert(mcpSessions)
        .values([{ sessionId, userId: actor.user.id }])
        .onConflictDoNothing();
      // `HANDOFF_BUTTON_BY_PHASE` is a Partial — draft and done are not in it, so
      // a verbose read here delivers no handoff and must therefore claim nothing.
      const draft = await createDocDraft(actor.account.id, "No-Handoff Spec", "P", "spec");
      created.docs.push(draft.id);

      await callToolWithSession(actor.user.id, sessionId, "get_doc", {
        ref: `${actor.account.slug}/main/specs/${draft.handle}`,
      });

      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n FROM agent_session_claims WHERE session_id = ${sessionId}`,
      )) as unknown as Array<{ n: number }>;
      // Awaiting the claim above the guard would write a row here — burning a
      // claim for a key that can never deliver, on every verbose draft read.
      expect(rows[0]?.n ?? 0).toBe(0);
    } finally {
      delete process.env.HANDOFF_SHARED_STORE_ENABLED;
    }
  });

// ── spec-510 t-7 (dec-6, dec-9) — the flags in COMBINATION ───────────────────
//
// NESTED inside this describe deliberately: it reuses the fixtures declared
// above (`actor`, `buildSpecRef`, `callToolWithSession`). Lifting it out would
// mean a second set of fixtures for the same Spec in the same phase — more code
// asserting less, and a second thing to keep in step.
//
// Each flag's own behaviour is covered above. This block covers what the tests
// above cannot see: that the two are genuinely independent when set together.
//
// WHY IT IS WORTH TESTING AT ALL. Both halves land in the SAME function on a
// global multi-tenant rollout. dec-6 split them into two switches precisely so a
// production symptom can be bisected in seconds without a deploy — but that
// promise is only worth something if the intermediate positions actually work.
// A switch you have never operated in the position you will reach for in an
// incident is not a switch.
//
// ONLY THE COMBINATIONS THAT CARRY MEANING. Eight exist; three are asserted:
//   - (handoff OFF, cadence ON) — dec-9's retreat: the shared store is suspected,
//     the cadence stays on. The position an incident actually reaches for.
//   - (both ON)                 — the target state after rollout.
//   - (both OFF)                — today's behaviour, already covered above by the
//     "byte-identical to the first" retreat-path test.
// The rest are permutations of the same two independent axes and testing them
// would assert arithmetic, not behaviour.
describe("spec-510 t-7 — cadence and handoff-storage flags are independent (ac-16, ac-21)", () => {
  const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-510/acs/ac-${n}`;
  const STATIC_MARKER = "classify-and-consult";
  const POINTER = "guidance shown earlier this session";

  it("handoff store OFF + cadence ON — the retreat position still cadences (dec-9)", async () => {
    tagAc(AC(16));
    tagAc(AC(21));
    delete process.env.HANDOFF_SHARED_STORE_ENABLED; // the Map, dec-9's retreat
    process.env.GUIDANCE_CADENCE_ENABLED = "true";
    const sessionId = "combo-sess-handoff-off";
    try {
      await db
        .insert(mcpSessions)
        .values([{ sessionId, userId: actor.user.id }])
        .onConflictDoNothing();

      const first = await callToolWithSession(actor.user.id, sessionId, "get_doc", {
        ref: buildSpecRef,
      });
      const second = await callToolWithSession(actor.user.id, sessionId, "get_doc", {
        ref: buildSpecRef,
      });

      // The cadence does not depend on where the HANDOFF claim is stored: it has
      // its own store and its own key. If rolling the handoff back also silenced
      // the cadence, the two switches would not be independent and dec-6's whole
      // reason for having two would be false.
      expect(first.content[0].text).toContain(STATIC_MARKER);
      expect(second.content[0].text).toContain(POINTER);
      expect(second.content[0].text).not.toContain(STATIC_MARKER);

      // …and with the store off, no HANDOFF claim was written to the shared
      // table. This is what makes the test a real combination rather than the
      // cadence test with an extra line: it pins BOTH axes in one run.
      //
      // ⚠ PREFIX MATCH, NOT `claims ? 'handoff'`. The key is
      // `handoff:<userId>:<specId>:<phase>` (handoffClaimKey), so an equality
      // test against the bare word is false for every row ever written and the
      // assertion would pass without observing anything. Caught here only
      // because the sibling test below asserts the same key is PRESENT and went
      // red on it.
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n FROM agent_session_claims
            WHERE session_id = ${sessionId}
              AND EXISTS (
                SELECT 1 FROM jsonb_object_keys(claims) k WHERE k LIKE 'handoff:%'
              )`,
      )) as unknown as Array<{ n: number }>;
      expect(rows[0]?.n ?? 0).toBe(0);
    } finally {
      delete process.env.GUIDANCE_CADENCE_ENABLED;
    }
  });

  it("both ON — the target state delivers the cadence and the shared claim together", async () => {
    tagAc(AC(16));
    tagAc(AC(21));
    process.env.HANDOFF_SHARED_STORE_ENABLED = "true";
    process.env.GUIDANCE_CADENCE_ENABLED = "true";
    const sessionId = "combo-sess-all-on";
    try {
      await db
        .insert(mcpSessions)
        .values([{ sessionId, userId: actor.user.id }])
        .onConflictDoNothing();

      const first = await callToolWithSession(actor.user.id, sessionId, "get_doc", {
        ref: buildSpecRef,
      });
      const second = await callToolWithSession(actor.user.id, sessionId, "get_doc", {
        ref: buildSpecRef,
      });

      expect(first.content[0].text).toContain(STATIC_MARKER);
      expect(second.content[0].text).toContain(POINTER);
      expect(second.content[0].text.length).toBeLessThan(first.content[0].text.length);

      // Both mechanisms wrote to the same row without treading on each other —
      // the cadence records bytes, the handoff records its claim. Asserting the
      // row alone would not show that; asserting both keys does.
      const rows = (await db.execute(
        sql`SELECT guidance_bytes::int AS bytes,
                   EXISTS (
                     SELECT 1 FROM jsonb_object_keys(claims) k WHERE k LIKE 'handoff:%'
                   ) AS claimed
            FROM agent_session_claims WHERE session_id = ${sessionId}`,
      )) as unknown as Array<{ bytes: number; claimed: boolean }>;
      expect(rows.length).toBe(1);
      expect(rows[0].claimed).toBe(true);
      expect(rows[0].bytes).toBeGreaterThan(0);
    } finally {
      delete process.env.HANDOFF_SHARED_STORE_ENABLED;
      delete process.env.GUIDANCE_CADENCE_ENABLED;
    }
  });
});
});
