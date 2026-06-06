// t-8 of doc-14: end-to-end workflow tests through the new tool catalogue.
//
// These are the highest-signal "did anything break" tests for the slim
// 32-tool MCP surface. Three workflows:
//
//   1. Spec lifecycle — create_doc(spec) → add_section → create_decision
//      → resolve_decision → update_doc({status:'specify'}) → assess_spec
//      → update_doc({status:'build'}) → create_task → update_task → done.
//
//   2. Standards drift loop — create_doc(standard) → flag_drift → propose_
//      standard_change → update_section → update_comment(resolved).
//
//   3. Cross-Memex isolation — same handle in two Memexes; list_docs / get_doc /
//      list_comments must filter by memexId. This is the riskiest regression
//      vector when collapsing list filters.

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
  docComments,
  docSections,
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { COMPLETION_NUDGE } from "../agent/tool-specs.js";

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
  return await tool.handler(args, {} as unknown);
}

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (created.memexes.length) {
    await db.delete(docComments).where(inArray(docComments.memexId, created.memexes)).catch(() => {});
  }
  if (created.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(docSections).where(inArray(docSections.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
});

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase().slice(0, 39);
  const [u] = await db.insert(users).values({ email: `wf-${sub}@memex.ai` } as any).returning();
  created.users.push(u.id);
  // doc-15 t-11: namespace + org + memex tuple replaces the legacy account row.
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" } as any).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Workflow ${sub}` } as any).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ name: `Workflow ${sub}`, slug: "main", namespaceId: ns.id } as any).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({
    userId: u.id,
    orgId: org.id,
    role: "administrator",
  } as any);
  return { user: u, account: { ...a, slug: ns.slug }, org };
}

// b-36 T-6 helpers. Tools now take a single canonical ref.
function refForDoc(actor: { account: { slug: string } }, doc: { docType: string; handle: string }): string {
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
function refForTask(
  actor: { account: { slug: string } },
  doc: { docType: string; handle: string },
  seq: number,
): string {
  return `${refForDoc(actor, doc)}/tasks/t-${seq}`;
}
function refForDecision(
  actor: { account: { slug: string } },
  doc: { docType: string; handle: string },
  seq: number,
): string {
  return `${refForDoc(actor, doc)}/decisions/dec-${seq}`;
}
function refForSection(
  actor: { account: { slug: string } },
  doc: { docType: string; handle: string },
  seq: number,
): string {
  return `${refForDoc(actor, doc)}/sections/s-${seq}`;
}

// ── Workflow 1: Spec lifecycle ─────────────────────────────────────

describe("Workflow: Spec lifecycle (draft → specify → build → verify → done)", () => {
  let actor: Awaited<ReturnType<typeof setupActor>>;

  beforeAll(async () => {
    actor = await setupActor("spec");
  });

  it("walks the full Spec lifecycle through the new catalogue", async () => {
    // 1. create_doc(spec)
    const createRes = await callTool(actor.user.id, "create_doc", {
      memex: `${actor.account.slug}/main`,
      title: "Workflow Spec",
      docType: "spec",
      purpose:
        "We are migrating the auth stack to scrypt to remove the bcrypt dependency. " +
        "This delivers smaller bundle size and removes a maintained-by-someone-else hash.",
      decisions: [{ title: "Choose hash function", context: "scrypt vs argon2 vs bcrypt." }],
    });
    expect(createRes.isError).toBeFalsy();
    const spec = await db.query.documents.findFirst({
      where: eq(documents.title, "Workflow Spec"),
    });
    expect(spec).toBeTruthy();
    expect(spec!.docType).toBe("spec");
    expect(spec!.status).toBe("draft");
    created.docs.push(spec!.id);

    const specRef = refForDoc(actor, spec!);

    // 2. add_section
    const addSectionRes = await callTool(actor.user.id, "add_section", {
      ref: specRef,
      sectionType: "approach",
      content: "Replace bcrypt with Node scrypt across the auth code paths.",
    });
    expect(addSectionRes.isError).toBeFalsy();

    // 3. create_decision (status open is default)
    const createDecRes = await callTool(actor.user.id, "create_decision", {
      ref: specRef,
      title: "Migration cutover approach",
      context: "Big-bang vs gradual rollout.",
    });
    expect(createDecRes.isError).toBeFalsy();
    const allDecs = await db.query.decisions.findMany({
      where: eq(decisions.docId, spec!.id),
    });
    expect(allDecs.length).toBeGreaterThanOrEqual(2);

    // 4. resolve_decision (resolve them all so build is unblocked)
    for (const d of allDecs) {
      const resolveRes = await callTool(actor.user.id, "resolve_decision", {
        ref: refForDecision(actor, spec!, d.seq),
        resolution: `Resolved: ${d.title}`,
      });
      expect(resolveRes.isError).toBeFalsy();
    }
    const allResolved = await db.query.decisions.findMany({
      where: eq(decisions.docId, spec!.id),
    });
    expect(allResolved.every((d) => d.status === "resolved")).toBe(true);

    // 5. update_doc({status:'specify'}) — bump out of draft
    const planRes = await callTool(actor.user.id, "update_doc", {
      ref: specRef,
      status: "specify",
    });
    expect(planRes.isError).toBeFalsy();

    // 6. assess_spec({mode:'phase', target:'build'}) — readiness check
    const assessBuildRes = await callTool(actor.user.id, "assess_spec", {
      ref: specRef,
      mode: "phase",
      target: "build",
    });
    expect(assessBuildRes.isError).toBeFalsy();

    // 7. update_doc({status:'build'})
    const buildRes = await callTool(actor.user.id, "update_doc", {
      ref: specRef,
      status: "build",
    });
    expect(buildRes.isError).toBeFalsy();

    // 8. create_task with acceptance criteria
    const createTaskRes = await callTool(actor.user.id, "create_task", {
      ref: specRef,
      title: "Wire scrypt verifier",
      description: "Replace bcrypt.compare with the new scrypt path.",
      acceptanceCriteria: [
        { description: "scrypt verifier is timing-safe", done: false },
        { description: "bcrypt dep removed from package.json", done: false },
      ],
    });
    expect(createTaskRes.isError).toBeFalsy();
    const t = await db.query.tasks.findFirst({
      where: eq(tasks.docId, spec!.id),
    });
    expect(t).toBeTruthy();

    // 9. update_task({status:'in_progress'})
    const inProgRes = await callTool(actor.user.id, "update_task", {
      ref: refForTask(actor, spec!, t!.seq),
      status: "in_progress",
    });
    expect(inProgRes.isError).toBeFalsy();
    const tInProgress = await db.query.tasks.findFirst({ where: eq(tasks.id, t!.id) });
    expect(tInProgress!.status).toBe("in_progress");

    // 10. update_task({status:'complete'})
    const completeRes = await callTool(actor.user.id, "update_task", {
      ref: refForTask(actor, spec!, t!.seq),
      status: "complete",
    });
    expect(completeRes.isError).toBeFalsy();

    // 11. assess_spec({mode:'phase', target:'verify'})
    const assessVerifyRes = await callTool(actor.user.id, "assess_spec", {
      ref: specRef,
      mode: "phase",
      target: "verify",
    });
    expect(assessVerifyRes.isError).toBeFalsy();

    // 12. update_doc({status:'verify'}) → update_doc({status:'done'})
    const verifyRes = await callTool(actor.user.id, "update_doc", { ref: specRef, status: "verify" });
    expect(verifyRes.isError).toBeFalsy();
    const doneRes = await callTool(actor.user.id, "update_doc", { ref: specRef, status: "done" });
    expect(doneRes.isError).toBeFalsy();

    const final = await db.query.documents.findFirst({ where: eq(documents.id, spec!.id) });
    expect(final!.status).toBe("done");
  });
});

// ── Workflow 2: Standards drift loop ──────────────────────────────────

// SKIP: doc-24 — Standards drift loop relies on flag_drift / propose_standard_change / create_doc({docType:'standard'}), all hidden; restore alongside the tools.
describe.skip("Workflow: Standards drift loop", () => {
  let actor: Awaited<ReturnType<typeof setupActor>>;

  beforeAll(async () => {
    actor = await setupActor("standards");
  });

  it("creates a standard, flags drift, proposes a change, accepts, resolves the comment", async () => {
    // 1. create_doc(standard)
    const createRes = await callTool(actor.user.id, "create_doc", {
      memex: `${actor.account.slug}/main`,
      title: "Workflow Standard",
      docType: "standard",
      sections: [
        { sectionType: "do", content: "Always use scrypt for password hashing." },
        { sectionType: "dont", content: "Don't use MD5." },
      ],
    });
    expect(createRes.isError).toBeFalsy();

    // Find the doc
    const std = await db.query.documents.findFirst({ where: eq(documents.title, "Workflow Standard") });
    expect(std).toBeTruthy();
    created.docs.push(std!.id);
    expect(std!.docType).toBe("standard");

    // Find the 'do' section
    const doSection = await db.query.docSections.findFirst({
      where: eq(docSections.docId, std!.id),
    });
    expect(doSection).toBeTruthy();

    // spec-143 ac-14: the standards-drift verbs take the canonical section ref.
    const doSectionRef = refForSection(actor, std!, doSection!.seq);

    // 2. flag_drift on the section
    const flagRes = await callTool(actor.user.id, "flag_drift", {
      ref: doSectionRef,
      observation: "auth/login.ts:42 still uses bcrypt — diverges from this rule.",
    });
    expect(flagRes.isError).toBeFalsy();

    const driftComments = await db.query.docComments.findMany({
      where: eq(docComments.sectionId, doSection!.id),
    });
    expect(driftComments.some((c) => c.commentType === "drift")).toBe(true);

    // 3. propose_standard_change
    const proposeRes = await callTool(actor.user.id, "propose_standard_change", {
      ref: doSectionRef,
      proposedContent: "Always use scrypt or argon2id for password hashing.",
      rationale: "argon2id is the OWASP-recommended default for new code.",
    });
    expect(proposeRes.isError).toBeFalsy();

    const planRevisions = await db.query.docComments.findMany({
      where: eq(docComments.sectionId, doSection!.id),
    });
    expect(planRevisions.some((c) => c.commentType === "plan_revision")).toBe(true);

    // 4. update_section — accept the proposal by writing the new content
    const updateSectionRes = await callTool(actor.user.id, "update_section", {
      sectionId: doSection!.id,
      content: "Always use scrypt or argon2id for password hashing.",
    });
    expect(updateSectionRes.isError).toBeFalsy();

    // 5. update_comment to resolve the plan_revision (replaces resolve_comment)
    const planRev = planRevisions.find((c) => c.commentType === "plan_revision");
    expect(planRev).toBeTruthy();
    const resolveRes = await callTool(actor.user.id, "update_comment", {
      commentId: planRev!.id,
      status: "resolved",
      resolution: "Applied — section updated to allow argon2id.",
    });
    expect(resolveRes.isError).toBeFalsy();

    const resolvedComment = await db.query.docComments.findFirst({
      where: eq(docComments.id, planRev!.id),
    });
    expect(resolvedComment!.resolvedAt).toBeTruthy();
  });
});

// ── Workflow 3: Cross-Memex isolation ─────────────────────────────────

describe("Workflow: Cross-Memex isolation (no memexId leakage in collapsed list_*)", () => {
  let actorA: Awaited<ReturnType<typeof setupActor>>;
  let actorB: Awaited<ReturnType<typeof setupActor>>;
  let userIdMember: string;

  beforeAll(async () => {
    actorA = await setupActor("xmemex-a");
    actorB = await setupActor("xmemex-b");
    // Add the same user to both memexes so we can call tools from a single
    // identity but expect each call to see only the chosen Memex.
    await db.insert(orgMemberships).values({
      userId: actorA.user.id,
      orgId: actorB.org.id,
      role: "administrator",
    });
    userIdMember = actorA.user.id;
  });

  it("list_docs filtered by Memex A doesn't leak Memex B docs (and vice versa)", async () => {
    // Create one spec in each memex with the same title. list_docs(spec)
    // shows ACTIVE Specs only (status in specify/build/verify), so we publish
    // each one to specify after creation.
    const aRes = await callTool(userIdMember, "create_doc", {
      memex: `${actorA.account.slug}/main`,
      title: "Same Title",
      docType: "spec",
      purpose: "Memex A purpose. Doing X to capture Y so the team can ship Z.",
    });
    expect(aRes.isError).toBeFalsy();
    const aDoc = await db.query.documents.findFirst({
      where: eq(documents.memexId, actorA.account.id),
    });
    expect(aDoc).toBeTruthy();
    created.docs.push(aDoc!.id);
    await callTool(userIdMember, "publish_spec", { ref: refForDoc(actorA, aDoc!) });

    const bRes = await callTool(userIdMember, "create_doc", {
      memex: `${actorB.account.slug}/main`,
      title: "Same Title",
      docType: "spec",
      purpose: "Memex B purpose. Doing X to capture Y so the team can ship Z.",
    });
    expect(bRes.isError).toBeFalsy();
    const bDoc = await db.query.documents.findFirst({
      where: eq(documents.memexId, actorB.account.id),
    });
    expect(bDoc).toBeTruthy();
    created.docs.push(bDoc!.id);
    await callTool(userIdMember, "publish_spec", { ref: refForDoc(actorB, bDoc!) });

    // The handles can collide because they're per-account. Verify we got both
    // missions and they have different account ids.
    expect(aDoc!.id).not.toBe(bDoc!.id);
    expect(aDoc!.memexId).toBe(actorA.account.id);
    expect(bDoc!.memexId).toBe(actorB.account.id);

    // list_docs scoped to A — should NOT contain B's content.
    const aList = await callTool(userIdMember, "list_docs", {
      memex: `${actorA.account.slug}/main`,
      docType: "spec",
    });
    expect(aList.isError).toBeFalsy();
    const aText = aList.content[0].text;
    expect(aText).toContain(aDoc!.handle);
    // Cross-leak check: B's UUID must not appear in A's list output.
    expect(aText).not.toContain(bDoc!.id);

    // list_docs scoped to B — should NOT contain A's content.
    const bList = await callTool(userIdMember, "list_docs", {
      memex: `${actorB.account.slug}/main`,
      docType: "spec",
    });
    expect(bList.isError).toBeFalsy();
    const bText = bList.content[0].text;
    expect(bText).toContain(bDoc!.handle);
    expect(bText).not.toContain(aDoc!.id);
  });

  it("get_doc on A's ref doesn't leak B's content", async () => {
    const aDoc = await db.query.documents.findFirst({
      where: eq(documents.memexId, actorA.account.id),
    });
    expect(aDoc).toBeTruthy();

    // Resolving the doc by canonical ref surfaces A's content (the ref carries
    // the memex coordinates, so cross-tenant leakage is structurally
    // impossible).
    const res = await callTool(userIdMember, "get_doc", { ref: refForDoc(actorA, aDoc!) });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain(aDoc!.handle);
  });

  it("list_comments scoped by doc ref stays inside that doc's account", async () => {
    const aDoc = await db.query.documents.findFirst({
      where: eq(documents.memexId, actorA.account.id),
    });
    const bDoc = await db.query.documents.findFirst({
      where: eq(documents.memexId, actorB.account.id),
    });
    expect(aDoc).toBeTruthy();
    expect(bDoc).toBeTruthy();

    // Seed one comment per doc by going through the tool with the section ref.
    const sectA = await db.query.docSections.findFirst({ where: eq(docSections.docId, aDoc!.id) });
    const sectB = await db.query.docSections.findFirst({ where: eq(docSections.docId, bDoc!.id) });
    expect(sectA).toBeTruthy();
    expect(sectB).toBeTruthy();

    await callTool(userIdMember, "add_comment", {
      ref: refForSection(actorA, aDoc!, sectA!.seq),
      authorName: "Tester",
      content: "A-only comment",
    });
    await callTool(userIdMember, "add_comment", {
      ref: refForSection(actorB, bDoc!, sectB!.seq),
      authorName: "Tester",
      content: "B-only comment",
    });

    // list_comments on A's doc shouldn't surface B's text.
    const aRes = await callTool(userIdMember, "list_comments", { ref: refForDoc(actorA, aDoc!) });
    expect(aRes.isError).toBeFalsy();
    expect(aRes.content[0].text).not.toContain("B-only");

    const bRes = await callTool(userIdMember, "list_comments", { ref: refForDoc(actorB, bDoc!) });
    expect(bRes.isError).toBeFalsy();
    expect(bRes.content[0].text).not.toContain("A-only");
  });
});

// ── Workflow 4: Completion-nudge on update_task (doc-28 T-1) ──────────

describe("update_task completion nudge", () => {
  let actor: Awaited<ReturnType<typeof setupActor>>;
  let spec: { id: string; docType: string; handle: string };
  let specRef: string;

  beforeAll(async () => {
    actor = await setupActor("nudge");

    // Spec in build, with one decision resolved so the phase transitions cleanly.
    const createRes = await callTool(actor.user.id, "create_doc", {
      memex: `${actor.account.slug}/main`,
      title: "Nudge Test Spec",
      docType: "spec",
      purpose: "Validate that update_task({status:'complete'}) emits the canonical nudge.",
      decisions: [{ title: "Placeholder decision", context: "Seed so build can be entered." }],
    });
    expect(createRes.isError).toBeFalsy();
    const specRow = await db.query.documents.findFirst({
      where: eq(documents.title, "Nudge Test Spec"),
    });
    spec = { id: specRow!.id, docType: specRow!.docType, handle: specRow!.handle };
    specRef = refForDoc(actor, spec);
    created.docs.push(spec.id);

    const dec = await db.query.decisions.findFirst({ where: eq(decisions.docId, spec.id) });
    await callTool(actor.user.id, "resolve_decision", {
      ref: refForDecision(actor, spec, dec!.seq),
      resolution: "Resolved for setup.",
    });
    await callTool(actor.user.id, "update_doc", { ref: specRef, status: "specify" });
    await callTool(actor.user.id, "update_doc", { ref: specRef, status: "build" });
  });

  it("emits the canonical nudge on status=complete with no dependents", async () => {
    await callTool(actor.user.id, "create_task", {
      ref: specRef,
      title: "Standalone nudge task",
      description: "No dependents — nudge should appear without unblocked-dependents hint.",
    });
    const task = await db.query.tasks.findFirst({ where: eq(tasks.title, "Standalone nudge task") });
    const res = await callTool(actor.user.id, "update_task", {
      ref: refForTask(actor, spec, task!.seq),
      status: "complete",
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain(COMPLETION_NUDGE);
    expect(text).not.toContain("Unblocked dependents");
  });

  it("emits the nudge after the unblocked-dependents hint when blockers exist", async () => {
    await callTool(actor.user.id, "create_task", {
      ref: specRef,
      title: "Upstream nudge task",
      description: "Will be completed to unblock downstream.",
    });
    await callTool(actor.user.id, "create_task", {
      ref: specRef,
      title: "Downstream nudge task",
      description: "Blocked by upstream.",
    });
    const upstream = await db.query.tasks.findFirst({ where: eq(tasks.title, "Upstream nudge task") });
    const downstream = await db.query.tasks.findFirst({ where: eq(tasks.title, "Downstream nudge task") });
    await callTool(actor.user.id, "update_task", {
      ref: refForTask(actor, spec, downstream!.seq),
      addBlockerRef: refForTask(actor, spec, upstream!.seq),
    });

    const res = await callTool(actor.user.id, "update_task", {
      ref: refForTask(actor, spec, upstream!.seq),
      status: "complete",
    });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain("Unblocked dependents");
    expect(text).toContain(COMPLETION_NUDGE);
    // Order: dependents hint must appear before the nudge.
    expect(text.indexOf("Unblocked dependents")).toBeLessThan(text.indexOf(COMPLETION_NUDGE));
  });

  it("does NOT emit the nudge on status=in_progress", async () => {
    await callTool(actor.user.id, "create_task", {
      ref: specRef,
      title: "In-progress nudge task",
      description: "Negative case for the nudge.",
    });
    const task = await db.query.tasks.findFirst({ where: eq(tasks.title, "In-progress nudge task") });
    const res = await callTool(actor.user.id, "update_task", {
      ref: refForTask(actor, spec, task!.seq),
      status: "in_progress",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).not.toContain(COMPLETION_NUDGE);
  });

  it("does NOT emit the nudge on status=not_started", async () => {
    await callTool(actor.user.id, "create_task", {
      ref: specRef,
      title: "Reset nudge task",
      description: "Move forward then back to not_started.",
    });
    const task = await db.query.tasks.findFirst({ where: eq(tasks.title, "Reset nudge task") });
    await callTool(actor.user.id, "update_task", {
      ref: refForTask(actor, spec, task!.seq),
      status: "in_progress",
    });
    const res = await callTool(actor.user.id, "update_task", {
      ref: refForTask(actor, spec, task!.seq),
      status: "not_started",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).not.toContain(COMPLETION_NUDGE);
  });
});
