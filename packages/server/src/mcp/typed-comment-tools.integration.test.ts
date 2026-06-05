// Integration tests for the t-8 typed comment MCP extensions (doc-10 Slice 2). Real DB.

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
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { createDocDraft } from "../services/documents.js";
import { updateSection } from "../services/sections.js";
import { createTask } from "../services/tasks.js";
import { createDecision } from "../services/decisions.js";
import { docSections as docSectionsTable } from "../db/schema.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_DEC1_ANCHOR = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-7";
const AC_SCOPE_ANCHOR = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-1";

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
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `mcp-tc-${sub}@memex.ai` } as any)
    .returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, account: a, nsSlug: ns.slug };
}

// b-36 T-6: helper builds canonical refs from the actor's namespace + memex
// slugs. Specs live under /specs/, free-form docs under /docs/ (b-105 rename).
function refForDoc(actor: { nsSlug: string }, doc: { docType: string; handle: string }): string {
  const docTypeUrl =
    doc.docType === "spec"
      ? "specs"
      : doc.docType === "standard"
        ? "standards"
        : doc.docType === "execution_plan"
          ? "execution-plans"
          : "docs";
  return `${actor.nsSlug}/main/${docTypeUrl}/${doc.handle}`;
}

function refForTask(
  actor: { nsSlug: string },
  doc: { docType: string; handle: string },
  taskSeq: number,
): string {
  return `${refForDoc(actor, doc)}/tasks/t-${taskSeq}`;
}

function refForDecision(
  actor: { nsSlug: string },
  doc: { docType: string; handle: string },
  decSeq: number,
): string {
  return `${refForDoc(actor, doc)}/decisions/dec-${decSeq}`;
}

function refForSection(
  actor: { nsSlug: string },
  doc: { docType: string; handle: string },
  sectionSeq: number,
): string {
  return `${refForDoc(actor, doc)}/sections/s-${sectionSeq}`;
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
  // Per dec-1 of doc-20 the MCP surface defaults to terse output. Pre-doc-20
  // tests assert against the verbose markdown surface, so opt in via the
  // documented `verbose: true` escape hatch unless the test sets it.
  const withVerbose = "verbose" in args ? args : { ...args, verbose: true };
  return await tool.handler(withVerbose, {} as unknown);
}

let actor: Awaited<ReturnType<typeof setupActor>>;

beforeAll(async () => {
  actor = await setupActor("tc");
});

describe("Typed comment MCP extensions (post-doc-14)", () => {
  it("registers the consolidated list_comments tool", () => {
    const server = createMcpServer(actor.user.id);
    const names = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    // Post doc-14: list_doc_comments / list_task_notes / list_open_questions /
    // review_doc_comments collapse into list_comments + filter args.
    expect(names).toContain("list_comments");
  });

  it("add_comment with type stamps source=agent and persists the type", async () => {
    const doc = await createDocDraft(actor.account.id, "Typed Doc", "P", "spec");
    created.docs.push(doc.id);
    const item = await createTask(actor.account.id, doc.id, "An item", "Desc");

    const result = await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "Memex agent",
      content: "Plan: do X then Y",
      type: "plan",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/AGENT · PLAN/);

    const comments = await db.query.docComments.findMany({
      where: eq(docComments.taskId, item.id),
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].commentType).toBe("plan");
    expect(comments[0].source).toBe("agent");
  });

  it("add_comment with anchorOffset creates a geo-comment and inserts the [^c-Ne] point marker into the section", async () => {
    tagAc(AC_DEC1_ANCHOR);
    tagAc(AC_SCOPE_ANCHOR);
    const doc = await createDocDraft(actor.account.id, "AnchorMcpDoc", "P", "spec");
    created.docs.push(doc.id);
    const section = doc.sections[0];
    const source = "The proxy emits llm_call events when an outbound call is made.";
    await updateSection(actor.account.id, section.id, source);

    const offset = source.indexOf(" when an outbound"); // just after "events"
    const result = await callTool(actor.user.id, "add_comment", {
      ref: refForSection(actor, doc, section.seq),
      authorName: "Memex agent",
      content: "Streaming chunks don't fire llm_call.",
      type: "issue",
      anchorOffset: offset,
    });
    expect(result.isError).toBeFalsy();

    const comments = await db.query.docComments.findMany({
      where: eq(docComments.sectionId, section.id),
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].source).toBe("agent");
    expect(comments[0].anchorSnippet).toBe(source);

    const refreshed = await db.query.docSections.findFirst({
      where: eq(docSectionsTable.id, section.id),
    });
    expect(refreshed!.content).toContain(`events[^c-${comments[0].seq}e] when an outbound`);
  });

  it("export_doc returns lossless markdown with comment threads expanded inline", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-100/acs/ac-5");
    const doc = await createDocDraft(actor.account.id, "ExportToolDoc", "P", "spec");
    created.docs.push(doc.id);
    const section = doc.sections[0];
    const source = "The proxy emits llm_call events when a call is made.";
    await updateSection(actor.account.id, section.id, source);
    await callTool(actor.user.id, "add_comment", {
      ref: refForSection(actor, doc, section.seq),
      authorName: "Memex agent",
      content: "Streaming chunks don't fire llm_call.",
      type: "issue",
      anchorOffset: source.indexOf(" when a call"),
    });

    const result = await callTool(actor.user.id, "export_doc", {
      ref: refForDoc(actor, doc),
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("# ExportToolDoc");
    expect(text).toContain("comment-start");
    expect(text).toContain("> Streaming chunks don't fire llm_call.");
    expect(text).not.toMatch(/\[\^c-\d+\]/);
  });

  it("add_comment with anchorOffset on a non-section target is rejected", async () => {
    const doc = await createDocDraft(actor.account.id, "AnchorRejectDoc", "P", "spec");
    created.docs.push(doc.id);
    const item = await createTask(actor.account.id, doc.id, "Item", "Desc");
    const result = await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "agent",
      content: "x",
      anchorOffset: 0,
    });
    expect(result.isError).toBeTruthy();
    expect(result.content[0].text).toMatch(/anchorOffset is only valid/);
  });

  it("add_comment rejects an invalid type", async () => {
    const doc = await createDocDraft(actor.account.id, "InvalidTypeDoc", "P", "spec");
    created.docs.push(doc.id);
    const item = await createTask(actor.account.id, doc.id, "Item", "Desc");
    const result = await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "agent",
      content: "x",
      type: "not-a-type",
    });
    expect(result.isError ?? !!result.content[0]?.text.match(/Invalid/)).toBeTruthy();
  });

  it("add_comment stores cross_reference fields", async () => {
    // doc-26 t-4/t-5: cross_reference comments now point at the target via a
    // structured FK column. b-36 T-6: the MCP tool accepts a canonical ref;
    // the service resolves it to the canonical id.
    const doc = await createDocDraft(actor.account.id, "CrossRefDoc", "P", "spec");
    created.docs.push(doc.id);
    const item = await createTask(actor.account.id, doc.id, "Item", "Desc");
    const targetTask = await createTask(actor.account.id, doc.id, "Target", "Desc");

    const result = await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "agent",
      content: "Belongs to another task",
      type: "cross_reference",
      referenceRef: refForTask(actor, doc, targetTask.seq),
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Cross-reference: task");

    const comments = await db.query.docComments.findMany({
      where: eq(docComments.taskId, item.id),
    });
    const xref = comments.find((c) => c.commentType === "cross_reference");
    expect(xref).toBeDefined();
    expect(xref!.referenceTaskId).toBe(targetTask.id);
    expect(xref!.referenceBriefId).toBeNull();
    expect(xref!.referenceStandardId).toBeNull();
    expect(xref!.referenceDecisionId).toBeNull();
  });

  it("list_comments filters by types", async () => {
    const doc = await createDocDraft(actor.account.id, "FilterDoc", "P", "spec");
    created.docs.push(doc.id);
    const item = await createTask(actor.account.id, doc.id, "Item", "Desc");

    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "plan stuff",
      type: "plan",
    });
    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "progress stuff",
      type: "progress",
    });

    const filtered = await callTool(actor.user.id, "list_comments", {
      ref: refForTask(actor, doc, item.seq),
      types: ["progress"],
    });
    expect(filtered.isError).toBeFalsy();
    const text = filtered.content[0].text;
    expect(text).toContain("progress stuff");
    expect(text).not.toContain("plan stuff");
  });

  it("list_doc_comments filters by types (via list_comments)", async () => {
    const doc = await createDocDraft(actor.account.id, "DocFilter", "P", "spec");
    created.docs.push(doc.id);
    const dec = await createDecision(actor.account.id, doc.id, "Q?", "ctx");
    const item = await createTask(actor.account.id, doc.id, "Item", "Desc");

    await callTool(actor.user.id, "add_comment", {
      ref: refForDecision(actor, doc, dec.seq),
      authorName: "a",
      content: "Need input",
      type: "question",
    });
    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "Plan",
      type: "plan",
    });

    const result = await callTool(actor.user.id, "list_comments", {
      ref: refForDoc(actor, doc),
      types: ["question"],
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("Need input");
    expect(text).not.toContain("Plan");
  });

  it("review_doc_comments excludes progress by default (via list_comments mode='review')", async () => {
    const doc = await createDocDraft(actor.account.id, "ReviewDoc", "P", "spec");
    created.docs.push(doc.id);
    const item = await createTask(actor.account.id, doc.id, "Item", "Desc");

    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "noisy progress",
      type: "progress",
    });
    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "important issue",
      type: "issue",
    });

    const review = await callTool(actor.user.id, "list_comments", {
      ref: refForDoc(actor, doc),
      mode: "review",
    });
    expect(review.isError).toBeFalsy();
    const text = review.content[0].text;
    expect(text).toContain("important issue");
    expect(text).not.toContain("noisy progress");
  });

  it("review_doc_comments respects explicit `types` override (via list_comments mode='review')", async () => {
    const doc = await createDocDraft(actor.account.id, "ReviewOverride", "P", "spec");
    created.docs.push(doc.id);
    const item = await createTask(actor.account.id, doc.id, "Item", "Desc");
    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "progress",
      type: "progress",
    });
    const review = await callTool(actor.user.id, "list_comments", {
      ref: refForDoc(actor, doc),
      mode: "review",
      types: ["progress"],
    });
    expect(review.isError).toBeFalsy();
    expect(review.content[0].text).toContain("progress");
  });

  it("list_task_notes returns plan/progress/issue/deferred/question only (via list_comments mode='task_notes')", async () => {
    const doc = await createDocDraft(actor.account.id, "NotesDoc", "P", "spec");
    created.docs.push(doc.id);
    const item = await createTask(actor.account.id, doc.id, "Item", "Desc");

    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "PLAN_SENTINEL",
      type: "plan",
    });
    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "ISSUE_SENTINEL",
      type: "issue",
    });
    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "DISCUSSION_SENTINEL",
      type: "discussion",
    });

    const result = await callTool(actor.user.id, "list_comments", {
      ref: refForTask(actor, doc, item.seq),
      mode: "task_notes",
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("PLAN_SENTINEL");
    expect(text).toContain("ISSUE_SENTINEL");
    expect(text).not.toContain("DISCUSSION_SENTINEL");
  });

  it("list_open_questions returns only question-typed open comments doc-wide (via list_comments)", async () => {
    const doc = await createDocDraft(actor.account.id, "QuestionsDoc", "P", "spec");
    created.docs.push(doc.id);
    const item = await createTask(actor.account.id, doc.id, "Item", "Desc");
    const dec = await createDecision(actor.account.id, doc.id, "Choice?", "ctx");

    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "Q_ON_ITEM",
      type: "question",
    });
    await callTool(actor.user.id, "add_comment", {
      ref: refForDecision(actor, doc, dec.seq),
      authorName: "a",
      content: "Q_ON_DEC",
      type: "question",
    });
    await callTool(actor.user.id, "add_comment", {
      ref: refForTask(actor, doc, item.seq),
      authorName: "a",
      content: "Not a question",
      type: "issue",
    });

    const result = await callTool(actor.user.id, "list_comments", {
      ref: refForDoc(actor, doc),
      types: ["question"],
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("Q_ON_ITEM");
    expect(text).toContain("Q_ON_DEC");
    expect(text).not.toContain("Not a question");
  });
});
