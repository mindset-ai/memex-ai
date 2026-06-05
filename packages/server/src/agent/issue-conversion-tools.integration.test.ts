// spec-112 t-6 — MCP/agent conversion+lifecycle tools: promoteFromIssueRef on
// create_doc (sideways bridge), convert_issue_to_task (down), kick_task_to_issue
// (up). Exercised through a hand-rolled agent ToolCtx, the same contract
// executeServerTool offers, so the assertions land on observable behaviour.
//
// AC emission: every test that proves an AC calls tagAc('<full canonical ref>').

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, issues, tasks, memexes, namespaces } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft, updateDocStatus } from "../services/documents.js";
import { createIssue, getIssue } from "../services/issues.js";
import { toolSpecs } from "./tool-specs.js";
import { parseRef } from "../services/refs.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import type { ToolCtx } from "./tool-specs.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-112/acs/ac-${n}`;

const createdDocIds: string[] = [];

let memexId: string;
let USER: string;

beforeAll(async () => {
  memexId = await makeTestMemex("convtools");
  const user = await upsertUserByEmail(`convtools-${Date.now()}@test.example`);
  USER = user.id;
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(issues).where(eq(issues.docId, id)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

async function slugsFor(id: string): Promise<{ namespace: string; memex: string }> {
  const mx = await db.query.memexes.findFirst({ where: eq(memexes.id, id) });
  if (!mx) throw new Error(`memex ${id} not found`);
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, mx.namespaceId) });
  if (!ns) throw new Error(`ns for ${id} not found`);
  return { namespace: ns.slug, memex: mx.slug };
}

async function makeSpec(title: string): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, title, `${title} overview`, "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle };
}

// Hand-rolled agent ctx mirroring buildAgentCtx (see issue-tools.integration.test.ts).
function ctxFor(boundMemex: string, userId: string, verbose: boolean): ToolCtx {
  return {
    userId,
    resolveMemexFromEntity: async () => boundMemex,
    resolveMemex: async () => boundMemex,
    resolveRef: async (ref: string) => {
      const parsed = parseRef(ref);
      if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
      const result = await resolveCanonicalRef(parsed.ref);
      if ("redirected" in result) {
        throw new ValidationError(`Ref redirected: "${ref}" → "${result.newRef}".`);
      }
      if ("notFound" in result) {
        throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
      }
      const entity = result.entity;
      const doc = "doc" in entity ? entity.doc : entity.row;
      if (doc.memexId !== boundMemex) {
        throw new NotFoundError(`Ref "${ref}" not found.`);
      }
      return {
        entity,
        memexId: doc.memexId,
        doc,
        slugs: { namespace: parsed.ref.namespace, memex: parsed.ref.memex },
      };
    },
    workspaceUrl: async () => (verbose ? "https://test.example" : ""),
    verbose,
  };
}

function spec(name: string) {
  const s = toolSpecs.find((t) => t.name === name);
  if (!s) throw new Error(`tool spec ${name} not found`);
  return s;
}

// ──────────────────────────────────────────────────────────────────────────
// promoteFromIssueRef on create_doc — sideways bridge (ac-6, ac-23, ac-24)
// ──────────────────────────────────────────────────────────────────────────
describe("create_doc promoteFromIssueRef — Issue → child Spec", () => {
  it("makes a child Spec whose parent_doc_id is the Issue's SOURCE Spec, preserving lineage (ac-23, ac-6)", async () => {
    tagAc(AC(23));
    tagAc(AC(6));
    const source = await makeSpec("Promote Source Spec");
    const issue = await createIssue({
      memexId,
      docId: source.id,
      title: "Needs its own Spec",
      body: "This is too big for a Task — promote it.",
      type: "todo",
    });
    const slugs = await slugsFor(memexId);
    const issueRef = `${slugs.namespace}/${slugs.memex}/specs/${source.handle}/issues/issue-${issue.seq}`;

    const ctx = ctxFor(memexId, USER, false);
    const out = await spec("create_doc").handler(
      { promoteFromIssueRef: issueRef, title: "Promoted Child Spec", purpose: "delivers the issue" },
      ctx,
    );

    // The new child Spec is created...
    const handleMatch = out.match(/\/specs\/(spec-\d+)/);
    expect(handleMatch).not.toBeNull();
    const child = await db.query.documents.findFirst({
      where: and(eq(documents.handle, handleMatch![1]), eq(documents.memexId, memexId)),
    });
    expect(child).toBeTruthy();
    createdDocIds.push(child!.id);
    // ...parented to the Issue's SOURCE Spec (lineage preserved — ac-23).
    expect(child!.parentDocId).toBe(source.id);
    expect(child!.docType).toBe("spec");
  });

  it("sets the Issue → converted (NOT resolved); it resolves only when the child Spec reaches done (ac-24)", async () => {
    tagAc(AC(24));
    const source = await makeSpec("Promote Resolve Source Spec");
    const issue = await createIssue({
      memexId,
      docId: source.id,
      title: "Promote then ship",
      body: "b",
      type: "todo",
    });
    const slugs = await slugsFor(memexId);
    const issueRef = `${slugs.namespace}/${slugs.memex}/specs/${source.handle}/issues/issue-${issue.seq}`;

    const ctx = ctxFor(memexId, USER, false);
    const out = await spec("create_doc").handler(
      { promoteFromIssueRef: issueRef, title: "Promote Resolve Child", purpose: "ship it" },
      ctx,
    );
    const childHandle = out.match(/\/specs\/(spec-\d+)/)![1];
    const child = (await db.query.documents.findFirst({
      where: and(eq(documents.handle, childHandle), eq(documents.memexId, memexId)),
    }))!;
    createdDocIds.push(child.id);

    // Immediately after promotion the Issue is converted, NOT resolved (ac-24).
    let now = await getIssue(memexId, issue.id);
    expect(now.status).toBe("converted");
    expect(now.promotedDocId).toBe(child.id);

    // Drive the child Spec to done — the auto-resolve hook fires.
    await updateDocStatus(memexId, child.id, "done");

    now = await getIssue(memexId, issue.id);
    expect(now.status).toBe("resolved");
  });

  it("does NOT resolve the Issue until the child reaches done — an intermediate phase leaves it converted (ac-24)", async () => {
    tagAc(AC(24));
    const source = await makeSpec("Promote Intermediate Source Spec");
    const issue = await createIssue({
      memexId,
      docId: source.id,
      title: "Promote, not yet done",
      body: "b",
      type: "todo",
    });
    const slugs = await slugsFor(memexId);
    const issueRef = `${slugs.namespace}/${slugs.memex}/specs/${source.handle}/issues/issue-${issue.seq}`;

    const ctx = ctxFor(memexId, USER, false);
    const out = await spec("create_doc").handler(
      { promoteFromIssueRef: issueRef, title: "Promote Intermediate Child", purpose: "wip" },
      ctx,
    );
    const childHandle = out.match(/\/specs\/(spec-\d+)/)![1];
    const child = (await db.query.documents.findFirst({
      where: and(eq(documents.handle, childHandle), eq(documents.memexId, memexId)),
    }))!;
    createdDocIds.push(child.id);

    // Move the child to a non-done phase — the Issue must stay converted.
    await updateDocStatus(memexId, child.id, "build");
    const now = await getIssue(memexId, issue.id);
    expect(now.status).toBe("converted");
  });

  it("rejects a promoteFromIssueRef that doesn't resolve to an issue", async () => {
    const source = await makeSpec("Promote Bad Ref Spec");
    const slugs = await slugsFor(memexId);
    const specRef = `${slugs.namespace}/${slugs.memex}/specs/${source.handle}`;
    const ctx = ctxFor(memexId, USER, false);
    await expect(
      spec("create_doc").handler(
        { promoteFromIssueRef: specRef, title: "x", purpose: "y" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// convert_issue_to_task + kick_task_to_issue via the tool surface (ac-29)
// ──────────────────────────────────────────────────────────────────────────
describe("convert_issue_to_task + kick_task_to_issue tool surface (ac-29)", () => {
  it("converts an issue down to a task, then kicks a task back up to an issue", async () => {
    tagAc(AC(29));
    const home = await makeSpec("Conv Kick Spec");
    const slugs = await slugsFor(memexId);
    const ctx = ctxFor(memexId, USER, false);

    // DOWN — register an issue, convert it to a task.
    const issue = await createIssue({
      memexId,
      docId: home.id,
      title: "Convert me down",
      body: "repro steps",
      type: "bug",
    });
    const issueRef = `${slugs.namespace}/${slugs.memex}/specs/${home.handle}/issues/issue-${issue.seq}`;
    const convOut = await spec("convert_issue_to_task").handler({ ref: issueRef }, ctx);
    expect(convOut).toContain("/tasks/t-");
    expect((await getIssue(memexId, issue.id)).status).toBe("converted");

    // UP — kick a standalone task back to an issue.
    const [task] = await db
      .insert(tasks)
      .values({ memexId, docId: home.id, seq: 700, title: "Kick me up", description: "needs offline work" } as never)
      .returning();
    const taskRef = `${slugs.namespace}/${slugs.memex}/specs/${home.handle}/tasks/t-${task.seq}`;
    const kickOut = await spec("kick_task_to_issue").handler(
      { ref: taskRef, reason: "needs a human" },
      ctx,
    );
    expect(kickOut).toContain("/issues/issue-");
    expect(kickOut).toContain("todo");
    // The task is deleted.
    expect(await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) })).toBeUndefined();
  });
});
