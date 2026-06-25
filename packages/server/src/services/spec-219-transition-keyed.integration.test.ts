// spec-219 ac-11 / ac-12 / ac-5 — the footer is TRANSITION-keyed (per-tool), the
// seat owns steering while handlers own result-reporting, and the seat never
// echoes a handler's slot nugget.
//
// ac-11: two different tools resolving the same Spec in the same phase can
//        produce different footers (the seat's per-tool steer registry).
// ac-12: the seat's footer does not echo a handler's result nugget for the same
//        call — no duplication.
// ac-5:  the per-tool nudge notion is preserved and centralized: the steer is
//        authored by the one seat (rides the footer), not a scattered handler.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
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
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { createDocDraft } from "./documents.js";
import { COMPLETION_NUDGE } from "../agent/tool-specs.js";
import { splitToolResult } from "../mcp/footer-delimiter.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-219/acs/ac-${n}`;

// A distinctive fragment of the update_section steer (STEER_BY_TOOL).
const SECTION_STEER = "capture it with create_decision";

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
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
interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

async function callTool(userId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

const textOf = (res: ToolResult) => res.content.map((c) => c.text).join("\n");

async function specifySpec(title: string): Promise<{ ref: string; sectionRef: string }> {
  const doc = await createDocDraft(actor.memexId, title, "Purpose.", "spec");
  created.docs.push(doc.id);
  await db.update(documents).set({ status: "specify" }).where(eq(documents.id, doc.id));
  const ref = `${actor.nsSlug}/main/specs/${doc.handle}`;
  return { ref, sectionRef: `${ref}/sections/s-1` };
}

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("spec219-transition");
});

describe("ac-11 — the footer is transition-keyed (per-tool)", () => {
  it("two tools resolving the same Spec in the same phase produce different footers", async () => {
    tagAc(AC(11));
    tagAc(AC(5));
    const { ref, sectionRef } = await specifySpec("Transition-Keyed Spec");

    // update_section carries the seat's per-tool steer (STEER_BY_TOOL).
    const sectionRes = await callTool(actor.user.id, "update_section", {
      ref: sectionRef,
      content: "Revised overview body.",
      verbose: true,
    });
    const sectionFooter = splitToolResult(textOf(sectionRes)).footer ?? "";

    // get_doc, same Spec, same phase — no per-tool steer registered.
    const getRes = await callTool(actor.user.id, "get_doc", { ref, verbose: true });
    const getFooter = splitToolResult(textOf(getRes)).footer ?? "";

    expect(sectionFooter).toContain(SECTION_STEER);
    expect(getFooter).not.toContain(SECTION_STEER);
    // Same Spec, same phase, different tool ⇒ different footers.
    expect(sectionFooter).not.toEqual(getFooter);
  });
});

describe("ac-5 — the per-tool steer is authored by the one seat (centralized)", () => {
  it("the steer rides the footer (after the delimiter), not the tool's body", async () => {
    tagAc(AC(5));
    const { sectionRef } = await specifySpec("Centralized Steer Spec");
    const res = await callTool(actor.user.id, "update_section", {
      ref: sectionRef,
      content: "Another revision.",
      verbose: true,
    });
    const { body, footer } = splitToolResult(textOf(res));
    expect(footer).toContain(SECTION_STEER); // seat-composed, in the footer
    expect(body).not.toContain(SECTION_STEER); // not in the handler's own body output
  });
});

describe("ac-2 — the agent is steered toward the next move (drives the five behaviours)", () => {
  it("build responses steer toward writing tagged tests; specify update_section steers toward decisions", async () => {
    tagAc(AC(2));
    // Build phase with an untested AC → the footer steers toward tests
    // created/run (the AC nag) — one of the five affirmed behaviours.
    const doc = await createDocDraft(actor.memexId, "Steer Behaviours Spec", "Purpose.", "spec");
    created.docs.push(doc.id);
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
    const ref = `${actor.nsSlug}/main/specs/${doc.handle}`;
    await callTool(actor.user.id, "create_ac", { ref, kind: "scope", statement: "An outcome to verify." });
    const buildFooter = splitToolResult(textOf(await callTool(actor.user.id, "get_doc", { ref }))).footer ?? "";
    expect(buildFooter).toMatch(/untested acceptance criteri/i);

    // Specify phase: editing a section steers toward capturing decisions — the
    // "scope + implementation ACs created / decisions resolved" behaviour.
    const { sectionRef } = await specifySpec("Steer Decisions Spec");
    const sectionFooter = splitToolResult(
      textOf(await callTool(actor.user.id, "update_section", { ref: sectionRef, content: "Edited.", verbose: true })),
    ).footer ?? "";
    expect(sectionFooter).toContain("create_decision");
  });
});

describe("ac-12 — the seat's footer does not echo a handler's result nugget", () => {
  it("update_task(complete) yields the completion nudge exactly once (no seat echo)", async () => {
    tagAc(AC(12));
    const doc = await createDocDraft(actor.memexId, "No-Echo Spec", "Purpose.", "spec");
    created.docs.push(doc.id);
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
    const specRef = `${actor.nsSlug}/main/specs/${doc.handle}`;
    await callTool(actor.user.id, "create_task", {
      ref: specRef,
      title: "Lone task",
      description: "Delivers something checkable.",
    });
    const task = await db.query.tasks.findFirst({ where: eq(tasks.docId, doc.id) });

    const res = await callTool(actor.user.id, "update_task", {
      ref: `${specRef}/tasks/t-${task!.seq}`,
      status: "complete",
      verbose: true,
    });
    const text = textOf(res);
    // The completion nudge is the handler's slot (result-reporting); the seat
    // registers NO steer for update_task, so it appears exactly once — the seat
    // never echoes the handler's nugget.
    expect(text.split(COMPLETION_NUDGE).length - 1).toBe(1);
  });
});
