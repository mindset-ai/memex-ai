// Behavioural pinning for the canonical tool catalogue.
//
// Post b-36 T-6: every entity-acting tool takes a single `ref` arg (canonical
// `<ns>/<mx>/<doc-type>/<handle>(/<child-type>/<child-handle>)?` form).
// UUIDs at the tool boundary are now a hard error (D-7); the parity tests
// that previously asserted UUID-vs-handle equivalence are gone with the old
// surface.
//
// What this file still pins:
//
//   1. **verbose-vs-terse divergence.** Each shared tool's handler must return
//      a different shape depending on `ctx.verbose`. MCP runs verbose=true
//      (rich markdown via formatters); the in-app agent loop runs verbose=false
//      (terse strings). If a refactor accidentally collapses one branch into
//      the other, the agent loop's parser breaks (verbose markdown leaks into
//      the LangGraph state) or MCP clients lose the doc-state envelope.
//      Pinned per-tool below for the most-edited surfaces.
//
//   2. **agent ctx cross-tenant guard.** `buildAgentCtx` in `agent/tools.ts`
//      validates that the resolved entity belongs to the pre-bound memexId
//      — throws NotFoundError on a cross-tenant ref. Defence-in-depth so a
//      tenant subdomain can't reach across by guessing refs from another
//      account.
//
//   3. **terse-output ref contract** (b-36 D-8 / dec-1 of doc-20). Every
//      refined terse mutation/list response carries a `ref:` line and NO raw
//      UUID — so a downstream tool call can paste the path directly.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  documents,
  decisions,
  tasks,
  docSections,
  docComments,
} from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { addSection } from "../services/sections.js";
import { addComment } from "../services/comments.js";
import { NotFoundError } from "../types/errors.js";
import { toolSpecs } from "./tool-specs.js";
import { executeServerTool } from "./tools.js";

const cleanup = {
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (cleanup.memexes.length) {
    // Comments are scoped via section/decision/task — purge by memexId.
    await db.delete(docComments).where(inArray(docComments.memexId, cleanup.memexes)).catch(() => {});
  }
  if (cleanup.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, cleanup.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, cleanup.docs)).catch(() => {});
    await db.delete(docSections).where(inArray(docSections.docId, cleanup.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, cleanup.docs)).catch(() => {});
  }
  for (const id of cleanup.memexes) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
});

// Look up the (namespace, memex) slug pair for a memexId so tests can compose
// canonical refs without re-querying inline. The memex's slug is always
// "main" by the test helper convention.
async function slugsFor(memexId: string): Promise<{ namespace: string; memex: string }> {
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) throw new Error(`memex ${memexId} not found`);
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, memex.namespaceId),
  });
  if (!ns) throw new Error(`namespace for memex ${memexId} not found`);
  return { namespace: ns.slug, memex: memex.slug };
}

function docRef(slugs: { namespace: string; memex: string }, handle: string): string {
  return `${slugs.namespace}/${slugs.memex}/specs/${handle}`;
}

function childRef(
  slugs: { namespace: string; memex: string },
  docHandle: string,
  type: "sections" | "decisions" | "tasks" | "comments",
  seq: number,
): string {
  const prefix = type === "sections" ? "s" : type === "decisions" ? "dec" : type === "tasks" ? "t" : "c";
  return `${slugs.namespace}/${slugs.memex}/specs/${docHandle}/${type}/${prefix}-${seq}`;
}

function specByName(name: string) {
  const spec = toolSpecs.find((s) => s.name === name);
  if (!spec) throw new Error(`Spec not found: ${name}`);
  return spec;
}

// Hand-rolled ctx that mirrors `buildAgentCtx` in agent/tools.ts. We can't
// import the private builder, so this inlines the same `resolveRefForAgent`
// contract: parse the ref, run the canonical resolver, enforce that the doc
// lives in the bound memex, then package up a ResolvedRef. Same observable
// behaviour the executeServerTool adapter offers.
import { parseRef } from "../services/refs.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";
import { ValidationError } from "../types/errors.js";
import type { ToolCtx } from "./tool-specs.js";

function ctxFor(memexId: string, userId: string, verbose: boolean): ToolCtx {
  return {
    userId,
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async (ref: string) => {
      const parsed = parseRef(ref);
      if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
      const result = await resolveCanonicalRef(parsed.ref);
      if ("redirected" in result) {
        throw new ValidationError(
          `Ref redirected: "${ref}" now lives at "${result.newRef}". Retry with the new ref.`,
        );
      }
      if ("notFound" in result) {
        throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
      }
      const entity = result.entity;
      const doc = "doc" in entity ? entity.doc : entity.row;
      if (doc.memexId !== memexId) {
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

// ──────────────────────────────────────────────────────────────────────────
// Verbose-vs-terse pinning
// ──────────────────────────────────────────────────────────────────────────

describe("tool-specs: verbose-vs-terse output divergence (doc-2 t-1)", () => {
  let memexId: string;
  let docId: string;
  let docHandle: string;
  let sectionId: string;
  let sectionSeq: number;
  let slugs: { namespace: string; memex: string };
  const userId = "00000000-0000-0000-0000-0000000000a1";

  beforeAll(async () => {
    memexId = await makeTestMemex("verbose-terse");
    cleanup.memexes.push(memexId);
    slugs = await slugsFor(memexId);
    const doc = await createDocDraft(memexId, "Pinning Doc", "For verbose/terse pinning.", "spec");
    docId = doc.id;
    docHandle = doc.handle;
    cleanup.docs.push(doc.id);
    const sec = await addSection(memexId, doc.id, "design", "Initial body.");
    sectionId = sec.id;
    sectionSeq = sec.seq;
  });

  it("update_section: verbose returns full doc state; terse returns one-liner", async () => {
    const spec = specByName("update_section");
    const ref = childRef(slugs, docHandle, "sections", sectionSeq);
    const verbose = await spec.handler(
      { ref, content: "Verbose body." },
      ctxFor(memexId, userId, true),
    );
    const terse = await spec.handler(
      { ref, content: "Terse body." },
      ctxFor(memexId, userId, false),
    );
    expect(terse).toMatch(/^Section updated/i);
    expect(terse.split("\n").length).toBeLessThan(3);
    expect(verbose).not.toBe(terse);
    // Verbose carries the doc handle + status, terse does not.
    expect(verbose).toContain("Pinning Doc");
    expect(terse).not.toContain("Pinning Doc");
  });

  it("create_decision: verbose returns full doc state; terse returns one-liner", async () => {
    const spec = specByName("create_decision");
    const ref = docRef(slugs, docHandle);
    const verbose = await spec.handler(
      { ref, title: "Verbose decision", context: "v" },
      ctxFor(memexId, userId, true),
    );
    const terse = await spec.handler(
      { ref, title: "Terse decision", context: "t" },
      ctxFor(memexId, userId, false),
    );
    expect(terse).toMatch(/^Decision created: ref: /);
    expect(verbose).toContain("Pinning Doc");
    expect(terse).not.toContain("Pinning Doc");
  });

  it("create_task: verbose returns full doc state; terse returns one-liner", async () => {
    const spec = specByName("create_task");
    // Tasks need the parent doc in build phase; bump it first.
    await db
      .update(documents)
      .set({ status: "build", statusChangedAt: new Date() })
      .where(eq(documents.id, docId));
    const ref = docRef(slugs, docHandle);
    const verbose = await spec.handler(
      { ref, title: "Verbose task", description: "v" },
      ctxFor(memexId, userId, true),
    );
    const terse = await spec.handler(
      { ref, title: "Terse task", description: "t" },
      ctxFor(memexId, userId, false),
    );
    expect(terse).toMatch(/^Task created: ref: /);
    expect(verbose).toContain("Pinning Doc");
    expect(terse).not.toContain("Pinning Doc");
  });

  it("update_comment: verbose includes doc-status header; terse is one-liner", async () => {
    // Need a comment to resolve.
    const note = await addComment(memexId, sectionId, "tester", "x", { type: "discussion" });
    const noteRef = childRef(slugs, docHandle, "comments", note.seq);
    const spec = specByName("update_comment");
    const terse = await spec.handler(
      { ref: noteRef, status: "resolved", resolution: "fixed" },
      ctxFor(memexId, userId, false),
    );
    expect(terse).toMatch(/^Comment resolved/);
    expect(terse.split("\n").length).toBeLessThan(3);

    // Re-create a fresh comment so verbose has something to resolve too.
    const note2 = await addComment(memexId, sectionId, "tester", "y", { type: "discussion" });
    const note2Ref = childRef(slugs, docHandle, "comments", note2.seq);
    const verbose = await spec.handler(
      { ref: note2Ref, status: "resolved", resolution: "fixed-verbose" },
      ctxFor(memexId, userId, true),
    );
    // Verbose carries the parent doc-status header + the formatted comment.
    expect(verbose).toContain("Pinning Doc");
    expect(verbose).not.toBe(terse);
  });

  it("get_doc: verbose returns full state; terse returns one-line summary", async () => {
    const spec = specByName("get_doc");
    const ref = docRef(slugs, docHandle);
    const verbose = await spec.handler({ ref }, ctxFor(memexId, userId, true));
    const terse = await spec.handler({ ref }, ctxFor(memexId, userId, false));
    // Terse shape is `ref: <path> "<title>" [<type>, <status>]` — single line.
    expect(terse.split("\n").length).toBe(1);
    expect(terse).toMatch(/\[spec, /);
    expect(verbose).not.toBe(terse);
    expect(verbose.length).toBeGreaterThan(terse.length);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Agent ctx cross-tenant guard
// ──────────────────────────────────────────────────────────────────────────

describe("agent ctx: cross-tenant guard (doc-2 t-1)", () => {
  let accountA: string;
  let accountB: string;
  let slugsB: { namespace: string; memex: string };
  let docB: { id: string; handle: string };
  let sectionBSeq: number;
  let decisionBSeq: number;
  let taskBSeq: number;
  let commentBSeq: number;
  const userId = "00000000-0000-0000-0000-0000000000b1";

  beforeAll(async () => {
    accountA = await makeTestMemex("crosstenant-a");
    accountB = await makeTestMemex("crosstenant-b");
    cleanup.memexes.push(accountA, accountB);
    slugsB = await slugsFor(accountB);
    const doc = await createDocDraft(accountB, "B-side doc", "Lives in account B.", "spec");
    docB = { id: doc.id, handle: doc.handle };
    cleanup.docs.push(doc.id);
    const sec = await addSection(accountB, doc.id, "design", "B body.");
    sectionBSeq = sec.seq;
    // Drop a decision, task, and comment in B for full coverage.
    const [dec] = await db
      .insert(decisions)
      .values({ memexId: accountB, docId: docB.id, seq: 1, title: "B decision" } as any)
      .returning();
    decisionBSeq = dec.seq;
    // Move B-side doc to build so we can create a task on it.
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, docB.id));
    const [t] = await db
      .insert(tasks)
      .values({ memexId: accountB, docId: docB.id, seq: 1, title: "B task", description: "x" } as any)
      .returning();
    taskBSeq = t.seq;
    const com = await addComment(accountB, sec.id, "tester", "B comment", { type: "discussion" });
    commentBSeq = com.seq;
  });

  // Each call below uses the account-A-bound ctx (via `executeServerTool`)
  // referencing a B-side ref. The expected answer is identical to "entity does
  // not exist" — NotFoundError. The user must not be able to tell, by error
  // message or behaviour, that the entity exists elsewhere.

  it("update_section refuses a section ref from another account", async () => {
    const ref = childRef(slugsB, docB.handle, "sections", sectionBSeq);
    await expect(
      executeServerTool(accountA, "update_section", { ref, content: "evil" }, userId),
    ).rejects.toThrow(NotFoundError);
  });

  it("get_doc refuses a doc ref from another account", async () => {
    const ref = docRef(slugsB, docB.handle);
    await expect(
      executeServerTool(accountA, "get_doc", { ref }, userId),
    ).rejects.toThrow(NotFoundError);
  });

  it("resolve_decision refuses a decision ref from another account", async () => {
    const ref = childRef(slugsB, docB.handle, "decisions", decisionBSeq);
    await expect(
      executeServerTool(accountA, "resolve_decision", { ref, resolution: "x" }, userId),
    ).rejects.toThrow(NotFoundError);
  });

  it("update_task refuses a task ref from another account", async () => {
    const ref = childRef(slugsB, docB.handle, "tasks", taskBSeq);
    await expect(
      executeServerTool(accountA, "update_task", { ref, status: "in_progress" }, userId),
    ).rejects.toThrow(NotFoundError);
  });

  it("update_comment refuses a comment ref from another account", async () => {
    const ref = childRef(slugsB, docB.handle, "comments", commentBSeq);
    await expect(
      executeServerTool(accountA, "update_comment", { ref, status: "resolved" }, userId),
    ).rejects.toThrow(NotFoundError);
  });

  it("the same entity refs DO work when ctx is bound to the owning account", async () => {
    // Symmetry check — the cross-tenant rejection isn't masking a broken
    // happy path. Bound to B, the same refs resolve normally.
    const out = await executeServerTool(
      accountB,
      "get_doc",
      { ref: docRef(slugsB, docB.handle) },
      userId,
    );
    expect(out).toContain("B-side doc");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// dec-1 / dec-4 terse-path contracts (doc-20 t-9) + b-36 D-8 ref emission
// ──────────────────────────────────────────────────────────────────────────
//
// Per-tool pin that every refined terse mutation/list response includes the
// affected entity's canonical `ref:` path — and NO raw UUID. b-36 D-2 / D-7
// hard-rejected UUIDs at the boundary so the parenthetical `(uuid: …)` from
// pre-b-36 outputs is gone.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("tool-specs: dec-1 / dec-4 terse-path contracts (post-b-36)", () => {
  let memexId: string;
  let slugs: { namespace: string; memex: string };
  let docHandle: string;
  let docId: string;
  let sectionSeq: number;
  const userId = "00000000-0000-0000-0000-0000000000c1";

  beforeAll(async () => {
    memexId = await makeTestMemex("dec1-terse");
    cleanup.memexes.push(memexId);
    slugs = await slugsFor(memexId);
    const doc = await createDocDraft(memexId, "Contracts Doc", "Pinning dec-1/dec-4.", "spec");
    docHandle = doc.handle;
    docId = doc.id;
    cleanup.docs.push(doc.id);
    const sec = await addSection(memexId, doc.id, "design", "Body.");
    sectionSeq = sec.seq;
    // Move to build so create_task is allowed.
    await db
      .update(documents)
      .set({ status: "build", statusChangedAt: new Date() })
      .where(eq(documents.id, docId));
  });

  it("create_task terse carries `ref:` and no UUID", async () => {
    const spec = specByName("create_task");
    const out = await spec.handler(
      { ref: docRef(slugs, docHandle), title: "Task A", description: "d" },
      ctxFor(memexId, userId, false),
    );
    expect(out).toMatch(/^Task created: ref: /);
    expect(out).not.toMatch(UUID_RE);
  });

  it("create_decision terse carries `ref:` and no UUID", async () => {
    const spec = specByName("create_decision");
    const out = await spec.handler(
      { ref: docRef(slugs, docHandle), title: "Decision A", context: "c" },
      ctxFor(memexId, userId, false),
    );
    expect(out).toMatch(/^Decision created: ref: /);
    expect(out).not.toMatch(UUID_RE);
  });

  it("resolve_decision terse carries `ref:` and names the next phase when last open decision resolves", async () => {
    // Fresh doc with exactly one open decision and a parent spec in 'plan'.
    const fresh = await createDocDraft(memexId, "Last-dec Doc", "x", "spec");
    cleanup.docs.push(fresh.id);
    await db
      .update(documents)
      .set({ status: "plan", statusChangedAt: new Date() })
      .where(eq(documents.id, fresh.id));
    const [dec] = await db
      .insert(decisions)
      .values({ memexId, docId: fresh.id, seq: 1, title: "Only decision" } as never)
      .returning();
    const spec = specByName("resolve_decision");
    const out = await spec.handler(
      {
        ref: childRef(slugs, fresh.handle, "decisions", dec.seq),
        resolution: "Chose path A.",
      },
      ctxFor(memexId, userId, false),
    );
    expect(out).toMatch(/^Decision resolved: ref: /);
    expect(out).not.toMatch(UUID_RE);
    expect(out.toLowerCase()).toContain("move to build");
  });

  it("update_decision edit-in-place: rewrites resolution prose without changing status", async () => {
    // Fresh resolved decision; the agent wants to polish wording without
    // reopening (which would step the Spec back to plan).
    const fresh = await createDocDraft(memexId, "Edit-in-place Doc", "x", "spec");
    cleanup.docs.push(fresh.id);
    const [dec] = await db
      .insert(decisions)
      .values({
        memexId,
        docId: fresh.id,
        seq: 1,
        title: "Polish target",
        status: "resolved",
        resolution: "Initial wording",
        resolvedAt: new Date(),
      } as never)
      .returning();
    const spec = specByName("update_decision");
    const out = await spec.handler(
      {
        ref: childRef(slugs, fresh.handle, "decisions", dec.seq),
        resolution: "Tightened wording, same decision",
      },
      ctxFor(memexId, userId, false),
    );
    expect(out).toMatch(/^Decision updated: ref: /);
    expect(out).toContain("[resolved]");
    expect(out).not.toMatch(UUID_RE);

    const [reread] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.id, dec.id));
    expect(reread.resolution).toBe("Tightened wording, same decision");
    expect(reread.status).toBe("resolved");
  });

  it("update_decision rejects combining status='open' with field edits", async () => {
    const fresh = await createDocDraft(memexId, "Combined-mode Doc", "x", "spec");
    cleanup.docs.push(fresh.id);
    const [dec] = await db
      .insert(decisions)
      .values({
        memexId,
        docId: fresh.id,
        seq: 1,
        title: "Combined-mode target",
        status: "resolved",
        resolution: "x",
        resolvedAt: new Date(),
      } as never)
      .returning();
    const spec = specByName("update_decision");
    await expect(
      spec.handler(
        {
          ref: childRef(slugs, fresh.handle, "decisions", dec.seq),
          status: "open",
          resolution: "edit and reopen at once",
        },
        ctxFor(memexId, userId, false),
      ),
    ).rejects.toThrow(/cannot combine/i);
  });

  it("update_task(addBlockerRef) terse appends [BLOCKED-by-…] marker", async () => {
    // Create a task to add a blocker to, plus another task to be the blocker.
    const [blocker] = await db
      .insert(tasks)
      .values({ memexId, docId, seq: 81, title: "Blocker task", description: "x" } as never)
      .returning();
    const [target] = await db
      .insert(tasks)
      .values({ memexId, docId, seq: 82, title: "Target task", description: "y" } as never)
      .returning();
    const spec = specByName("update_task");
    const out = await spec.handler(
      {
        ref: childRef(slugs, docHandle, "tasks", target.seq),
        addBlockerRef: childRef(slugs, docHandle, "tasks", blocker.seq),
      },
      ctxFor(memexId, userId, false),
    );
    expect(out).toMatch(/ref: /);
    expect(out).not.toMatch(UUID_RE);
    expect(out).toMatch(/\[BLOCKED-by-T-\d+\]/);
  });

  it("update_task(status='complete') terse names unblocked dependents", async () => {
    const [dep] = await db
      .insert(tasks)
      .values({ memexId, docId, seq: 83, title: "Dep task", description: "x" } as never)
      .returning();
    const [blockedTask] = await db
      .insert(tasks)
      .values({ memexId, docId, seq: 84, title: "Blocked by dep", description: "y" } as never)
      .returning();
    const updateSpec = specByName("update_task");
    // Wire the blocker
    await updateSpec.handler(
      {
        ref: childRef(slugs, docHandle, "tasks", blockedTask.seq),
        addBlockerRef: childRef(slugs, docHandle, "tasks", dep.seq),
      },
      ctxFor(memexId, userId, false),
    );
    // Complete the dep — should report blockedTask as unblocked
    const out = await updateSpec.handler(
      { ref: childRef(slugs, docHandle, "tasks", dep.seq), status: "complete" },
      ctxFor(memexId, userId, false),
    );
    expect(out).toMatch(/Unblocked dependents: t-\d+/);
  });

  it("update_doc(status) terse appends Phase / Allowed now line", async () => {
    const m = await createDocDraft(memexId, "Phase doc", "x", "spec");
    cleanup.docs.push(m.id);
    const spec = specByName("update_doc");
    const out = await spec.handler(
      { ref: docRef(slugs, m.handle), status: "plan" },
      ctxFor(memexId, userId, false),
    );
    expect(out).toMatch(/ref: /);
    expect(out).not.toMatch(UUID_RE);
    expect(out).toMatch(/Phase: plan/);
    expect(out.toLowerCase()).toContain("allowed now");
  });

  it("publish_spec terse appends Phase / Allowed now line", async () => {
    const m = await createDocDraft(memexId, "Publishable", "x", "spec");
    cleanup.docs.push(m.id);
    const spec = specByName("publish_spec");
    const out = await spec.handler(
      { ref: docRef(slugs, m.handle) },
      ctxFor(memexId, userId, false),
    );
    expect(out).toMatch(/Spec ref: .* published/);
    expect(out).not.toMatch(UUID_RE);
    expect(out).toMatch(/Phase: plan/);
  });

  it("delete_task terse carries `ref:`", async () => {
    const [t] = await db
      .insert(tasks)
      .values({ memexId, docId, seq: 90, title: "Doomed", description: "x" } as never)
      .returning();
    const spec = specByName("delete_task");
    const out = await spec.handler(
      { ref: childRef(slugs, docHandle, "tasks", t.seq) },
      ctxFor(memexId, userId, false),
    );
    expect(out).toMatch(/Task ref: .* "Doomed" deleted\./);
    expect(out).not.toMatch(UUID_RE);
  });

  it("add_section terse carries `ref:`", async () => {
    const spec = specByName("add_section");
    const out = await spec.handler(
      { ref: docRef(slugs, docHandle), sectionType: "extra-section-xyz", content: "body" },
      ctxFor(memexId, userId, false),
    );
    expect(out).toMatch(/^Added /);
    expect(out).toMatch(/ref: /);
    expect(out).not.toMatch(UUID_RE);
  });

  it("get_doc terse spec carries `ref:` as single line", async () => {
    const spec = specByName("get_doc");
    const out = await spec.handler(
      { ref: docRef(slugs, docHandle) },
      ctxFor(memexId, userId, false),
    );
    expect(out.split("\n").length).toBe(1);
    expect(out).toMatch(/ref: /);
    expect(out).not.toMatch(UUID_RE);
    expect(out).toMatch(/\[spec, /);
  });

  it("list_tasks terse: every line carries `ref:` + READY|BLOCKED marker", async () => {
    const spec = specByName("list_tasks");
    const out = await spec.handler(
      { ref: docRef(slugs, docHandle) },
      ctxFor(memexId, userId, false),
    );
    const lines = out.split("\n").filter((l) => l.trim().startsWith("- ref:"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/ref: /);
      expect(line).not.toMatch(UUID_RE);
      expect(line).toMatch(/\b(READY|BLOCKED-by-)/);
    }
  });

  it("list_tasks readyOnly terse: every line carries `ref:` + READY", async () => {
    const spec = specByName("list_tasks");
    const out = await spec.handler(
      { ref: docRef(slugs, docHandle), readyOnly: true },
      ctxFor(memexId, userId, false),
    );
    if (out !== "No ready tasks.") {
      const lines = out.split("\n").filter((l) => l.trim().startsWith("- ref:"));
      for (const line of lines) {
        expect(line).toMatch(/ref: /);
        expect(line).not.toMatch(UUID_RE);
        expect(line).toContain("READY");
      }
    }
  });

  it("list_docs default terse: every line carries `ref:`", async () => {
    const spec = specByName("list_docs");
    // list_docs is memex-scoped (no ref). Pass the memex slash form.
    const out = await spec.handler(
      { memex: `${slugs.namespace}/${slugs.memex}` },
      ctxFor(memexId, userId, false),
    );
    if (out !== "No active specs in this Memex.") {
      const lines = out.split("\n").filter((l) => l.trim().startsWith("- ref:"));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/ref: /);
        expect(line).not.toMatch(UUID_RE);
      }
    }
  });

  it("list_comments terse emits one line per comment, not a count", async () => {
    // Drop two comments on the same section.
    const sec = await db.query.docSections.findFirst({
      where: eq(docSections.docId, docId),
    });
    await addComment(memexId, sec!.id, "tester", "First c", { type: "discussion" });
    await addComment(memexId, sec!.id, "tester", "Second c", { type: "discussion" });
    const spec = specByName("list_comments");
    const out = await spec.handler(
      { ref: childRef(slugs, docHandle, "sections", sec!.seq) },
      ctxFor(memexId, userId, false),
    );
    const lines = out.split("\n").filter((l) => l.trim().startsWith("- "));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).toMatch(/ref: /);
      expect(line).not.toMatch(UUID_RE);
      expect(line).toMatch(/\[/); // [type, status]
    }
  });
});
