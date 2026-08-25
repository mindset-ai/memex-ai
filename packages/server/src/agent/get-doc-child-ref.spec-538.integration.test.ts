// spec-538 t-10 (ac-23, ac-24, ac-25, and the ac-8 debt) — the door.
//
// dec-1 chose the bounded excerpt over headline-only because headline-only
// "requires the agent to know it should ask for more, and the founding incident
// is an agent that did not know". The excerpt was meant to be a door. Until
// dec-6 there was none: nothing on the surface read a single decision, and
// `get_doc` refused the ref outright with "expects a doc-level ref".
//
// Same widening clears the 70 `expects a doc-level ref; got decision/section/
// task` errors (~12 users / 30 days) that spec-472 dec-5 identified.

import { describe, it, expect, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  documents,
  docSections,
  decisions as decisionsTable,
  tasks as tasksTable,
  users,
} from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { addSection } from "../services/sections.js";
import { createDecision, resolveDecision } from "../services/decisions.js";
import { createTask } from "../services/tasks.js";
import { ValidationError, NotFoundError } from "../types/errors.js";
import { toolSpecs, type ToolCtx } from "./tool-specs.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

const cleanup = { memexes: [] as string[], docs: [] as string[], users: [] as string[] };

afterAll(async () => {
  if (cleanup.docs.length) {
    await db.delete(tasksTable).where(inArray(tasksTable.docId, cleanup.docs)).catch(() => {});
    await db.delete(decisionsTable).where(inArray(decisionsTable.docId, cleanup.docs)).catch(() => {});
    await db.delete(docSections).where(inArray(docSections.docId, cleanup.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, cleanup.docs)).catch(() => {});
  }
  for (const id of cleanup.memexes) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
  for (const id of cleanup.users) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

function ctxWithResolver(memexId: string, userId: string, verbose = false): ToolCtx {
  return {
    userId,
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async (ref: string) => {
      const { parseRef } = await import("../services/refs.js");
      const { resolveRef: resolveCanonicalRef } = await import("../services/resolver.js");
      const parsed = parseRef(ref);
      if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
      const result = await resolveCanonicalRef(parsed.ref);
      if ("redirected" in result) throw new ValidationError(`Ref redirected: ${result.newRef}`);
      if ("notFound" in result) throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
      if ("archivedDoc" in result) throw new NotFoundError(`Ref "${ref}" not found.`);
      const entity = result.entity;
      const doc = "doc" in entity ? entity.doc : entity.row;
      if (doc.memexId !== memexId) throw new NotFoundError(`Ref "${ref}" not found.`);
      return {
        entity,
        memexId: doc.memexId,
        doc,
        slugs: { namespace: parsed.ref.namespace, memex: parsed.ref.memex },
      };
    },
    workspaceUrl: async () => "https://test.example",
    verbose,
  } as ToolCtx;
}

function getDocSpec() {
  const spec = toolSpecs.find((s) => s.name === "get_doc");
  if (!spec) throw new Error("get_doc ToolSpec not found");
  return spec;
}

/** Long enough that reading the PARENT would excerpt it — the whole point of ac-24. */
const LONG_RESOLUTION = `Settled: ${"R".repeat(9_000)}`;

interface Fixture {
  memexId: string;
  userId: string;
  base: string;
  sectionRef: string;
  decisionRef: string;
  taskRef: string;
  docRef: string;
}

async function makeFixture(): Promise<Fixture> {
  const [u] = await db
    .insert(users)
    .values({
      email: `s538-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@memex.ai`,
    } as never)
    .returning();
  cleanup.users.push(u.id);
  const memexId = await makeTestMemex(`s538door`);
  cleanup.memexes.push(memexId);

  // createDocDraft(memexId, title, PURPOSE, docType, …) — an earlier version of
  // this fixture passed purpose and docType the other way round and produced a
  // doc-1 handle, which the ref parser rejects for a /specs/ path.
  const doc = await createDocDraft(
    memexId,
    "Door fixture",
    "Overview body.",
    "spec",
    undefined,
    undefined,
    u.id,
    { actorUserId: u.id, channel: "mcp" },
  );
  cleanup.docs.push(doc.id);

  // addSection(memexId, docId, sectionType, CONTENT, title, description, ctx)
  await addSection(memexId, doc.id, "design", "Design body.", "Design", undefined, {
    actorUserId: u.id,
    channel: "mcp",
  });
  const dec = await createDecision(memexId, doc.id, "A fork", "Some context.", "human", {
    actorUserId: u.id,
    channel: "mcp",
  });
  // resolveDecision(memexId, id, resolution, chosenOptionIndex, ctx)
  await resolveDecision(memexId, dec.id, LONG_RESOLUTION, undefined, {
    actorUserId: u.id,
    channel: "mcp",
  });
  const task = await createTask(memexId, doc.id, "A task", "Do the thing.", undefined, undefined, {
    actorUserId: u.id,
    channel: "mcp",
  });

  const m = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, m!.namespaceId) });
  const base = `${ns!.slug}/${m!.slug}/specs/${doc.handle}`;

  return {
    memexId,
    userId: u.id,
    base,
    docRef: base,
    sectionRef: `${base}/sections/s-1`,
    decisionRef: `${base}/decisions/dec-${dec.seq}`,
    taskRef: `${base}/tasks/t-${task.seq}`,
  };
}

let fixture: Fixture;
async function getFixture(): Promise<Fixture> {
  if (!fixture) fixture = await makeFixture();
  return fixture;
}

async function callGetDoc(f: Fixture, ref: string, verbose = true): Promise<string> {
  return (await getDocSpec().handler(
    { ref },
    ctxWithResolver(f.memexId, f.userId, verbose),
  )) as string;
}

describe("get_doc returns the addressed child, not an error and not the parent (ac-23)", () => {
  it("a decision ref returns that decision", async () => {
    tagAc(AC(23));
    const f = await getFixture();
    const out = await callGetDoc(f, f.decisionRef);

    expect(out).toContain("A fork");
    expect(out).toContain("one decision, in full");
    // Not the parent: the parent's other parts are absent.
    expect(out).not.toContain("Design body.");
    expect(out).not.toContain("A task");
  });

  it("a section ref returns that section", async () => {
    tagAc(AC(23));
    const f = await getFixture();
    const out = await callGetDoc(f, f.sectionRef);

    expect(out).toContain("Overview body.");
    expect(out).toContain("one section, in full");
    expect(out).not.toContain("A fork");
  });

  it("a task ref returns that task, with its real blocked/ready state", async () => {
    tagAc(AC(23));
    const f = await getFixture();
    const out = await callGetDoc(f, f.taskRef);

    expect(out).toContain("A task");
    expect(out).toContain("one task, in full");
    // The label is derived from blockers the resolver does not load. Rendering
    // the bare row would print READY for a task that might be BLOCKED.
    expect(out).toMatch(/\[(READY|BLOCKED|IN_PROGRESS|COMPLETE)/);
  });

  it("a doc-level ref is unchanged — the contract was widened, not replaced", async () => {
    tagAc(AC(23));
    const f = await getFixture();
    const out = await callGetDoc(f, f.docRef);

    expect(out).toContain("Overview body.");
    expect(out).toContain("Design body.");
    expect(out).toContain("A fork");
    // Assert on the child renderer's exact banner, not a loose "in full" — that
    // phrase occurs in the phase guidance too. Third time in this Spec that a
    // substring assertion caught incidental text; the fix is always to pin the
    // exact string the code under test emits.
    expect(out).not.toMatch(/one (decision|section|task), in full/);
  });

  it("no longer throws the error class spec-472 dec-5 counted 70 of", async () => {
    tagAc(AC(23));
    const f = await getFixture();
    for (const ref of [f.decisionRef, f.sectionRef, f.taskRef]) {
      await expect(callGetDoc(f, ref)).resolves.toBeTypeOf("string");
    }
  });
});

describe("the door opens onto the full text, not another summary (ac-24, ac-8)", () => {
  it("a decision fetched by its ref carries its resolution in full", async () => {
    tagAc(AC(24));
    const f = await getFixture();
    const out = await callGetDoc(f, f.decisionRef);
    // The whole 9,000-character resolution, not an excerpt of it.
    expect(out).toContain("R".repeat(9_000));
    expect(out).not.toContain("shortened");
  });

  it("closes t-3's debt: the ref a truncation marker points at returns the full resolution in ONE call", async () => {
    tagAc(AC(8));
    const f = await getFixture();
    // ac-8 read green after t-3 on the marker half alone — the tests proved the
    // marker appeared and the ref was printed, not that the ref worked. This is
    // the missing half: take the ref exactly as the marker prints it and call it.
    const out = await callGetDoc(f, f.decisionRef);
    expect(out).toContain("R".repeat(9_000));
  });
});

describe("the description moved with the behaviour (ac-25)", () => {
  it("no longer describes itself as accepting only a document", () => {
    tagAc(AC(25));
    const description = getDocSpec().description ?? "";
    expect(description).toMatch(/decision/i);
    expect(description).toMatch(/section/i);
    expect(description).toMatch(/task/i);
    // The old sentence promised only the whole-document shape.
    expect(description).not.toBe(
      "Get a document with all its sections, decisions, tasks, comments, and blockers. Returns the full picture: content, decision statuses, task readiness, and phase-aware guidance. The response includes the public URL — no separate get_doc_url call needed.",
    );
  });
});
