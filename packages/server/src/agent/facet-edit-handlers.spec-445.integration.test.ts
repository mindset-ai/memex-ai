// spec-445 — editing a task's or decision's facet classification through the EXISTING update_task
// and update_decision tools (dec-1). End-to-end through executeServerTool against a seeded
// facet vocabulary + a facet-tagged standard, mirroring the spec-423 consume-handler tests.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { toolManifest } from "@memex/shared";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  docSections,
  standardClauses,
  standardClauseFacets,
  facets,
  tasks,
  decisions,
  taskFacetBallots,
  decisionFacetBallots,
} from "../db/schema.js";
import { executeServerTool } from "./tools.js";
// get_doc (verbose) renders exactly formatState(url, await fullDocState(...)); test that
// path directly since executeServerTool forces ctx.verbose=false.
import { fullDocState, formatState } from "./handlers/tool-contract.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-445";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let userId: string;
let memexId: string;
let specRef: string;
let specDocId: string;
// A second, VOCAB-LESS memex for the no-op case (ac-7).
let bareMemexId: string;
let bareSpecRef: string;
let bareSpecDocId: string;

const refOf = (out: string) => out.match(/ref:\s+(\S+)/)![1];
const seqOf = (ref: string, kind: "t" | "dec") => Number(ref.match(new RegExp(`${kind}-(\\d+)`))![1]);
type Verdict = Record<string, boolean>;

// The stored verdict for a specific task/decision (by its seq within the main spec doc).
async function taskVerdict(ref: string): Promise<Verdict | undefined> {
  const [row] = await db
    .select({ verdict: taskFacetBallots.verdict })
    .from(taskFacetBallots)
    .innerJoin(tasks, eq(tasks.id, taskFacetBallots.taskId))
    .where(and(eq(tasks.docId, specDocId), eq(tasks.seq, seqOf(ref, "t"))));
  return row?.verdict as Verdict | undefined;
}
async function decisionVerdict(ref: string): Promise<Verdict | undefined> {
  const [row] = await db
    .select({ verdict: decisionFacetBallots.verdict })
    .from(decisionFacetBallots)
    .innerJoin(decisions, eq(decisions.id, decisionFacetBallots.decisionId))
    .where(and(eq(decisions.docId, specDocId), eq(decisions.seq, seqOf(ref, "dec"))));
  return row?.verdict as Verdict | undefined;
}

async function seedOrgMemex(sub: string, withVocab: boolean): Promise<{ memexId: string; specRef: string; specDocId: string }> {
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
  await db.insert(orgMemberships).values({ userId, orgId: org.id, role: "administrator" });
  if (withVocab) {
    const fid = new Map<string, string>();
    for (const key of ["xc-security", "xc-perf"]) {
      const [f] = await db.insert(facets).values({ ownerType: "org", ownerId: org.id, key, description: key }).returning();
      fid.set(key, f.id);
    }
    const [std] = await db.insert(documents).values({ memexId: mx.id, handle: "std-1", title: "Auth guard standard", docType: "standard", status: "approved" }).returning();
    const [sec] = await db.insert(docSections).values({ docId: std.id, sectionType: "rule", content: "Unauthorized access returns 404.", seq: 1, position: 1 }).returning();
    const [cl] = await db.insert(standardClauses).values({ memexId: mx.id, docId: std.id, sectionId: sec.id, seq: 1, position: 1, body: "404 not 403" }).returning();
    await db.insert(standardClauseFacets).values({ memexId: mx.id, clauseId: cl.id, facetId: fid.get("xc-security")! });
  }
  const [spec] = await db.insert(documents).values({ memexId: mx.id, handle: "spec-1", title: "Consumer spec", docType: "spec", status: "build" }).returning();
  return { memexId: mx.id, specRef: `${ns.slug}/main/specs/spec-1`, specDocId: spec.id };
}

beforeAll(async () => {
  const stamp = () => `s445-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${stamp()}@example.com` } as never).returning();
  userId = u.id;
  const main = await seedOrgMemex(stamp(), true);
  memexId = main.memexId;
  specRef = main.specRef;
  specDocId = main.specDocId;
  const bare = await seedOrgMemex(stamp(), false);
  bareMemexId = bare.memexId;
  bareSpecRef = bare.specRef;
  bareSpecDocId = bare.specDocId;
});

afterAll(async () => {
  for (const mid of [memexId, bareMemexId]) {
    await db.delete(documents).where(eq(documents.memexId, mid)).catch(() => {});
    await db.delete(memexes).where(eq(memexes.id, mid)).catch(() => {});
  }
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

// A COMPLETE verdict over the two-facet vocab.
const ballot = (security: boolean, perf: boolean) => ({ verdict: { "xc-security": security, "xc-perf": perf }, none: false });

describe("update_task edits a task's facets in place (spec-445 dec-1, ac-5/ac-7)", () => {
  it("replaces the stored ballot, re-routes, and re-surfaces the governing standard (ac-5, ac-7)", async () => {
    tagAc(AC(5));
    tagAc(AC(7)); // reuses the create-path validate+store+route machinery
    tagAc(AC(1)); // scope: edit via the EXISTING update tool
    tagAc(AC(2)); // scope: editing replaces the whole verdict and re-surfaces the standards
    const ref = refOf(await executeServerTool(memexId, "create_task", { ref: specRef, title: "Wire the guard", description: "harden authz", facetBallot: ballot(false, true) }, userId));
    expect(await taskVerdict(ref)).toEqual({ "xc-security": false, "xc-perf": true });

    const out = await executeServerTool(memexId, "update_task", { ref, facetBallot: ballot(true, false) }, userId);
    expect(out).toContain("std-1"); // re-routed on the new (security-true) ballot
    expect(await taskVerdict(ref)).toEqual({ "xc-security": true, "xc-perf": false }); // replaced in place
  });

  it("rejects a provided-but-incomplete ballot (re-handing the vocab); a title-only edit leaves facets unchanged (ac-5)", async () => {
    tagAc(AC(5));
    const ref = refOf(await executeServerTool(memexId, "create_task", { ref: specRef, title: "Another task", description: "x", facetBallot: ballot(true, false) }, userId));
    await expect(
      executeServerTool(memexId, "update_task", { ref, facetBallot: { verdict: { "xc-security": true }, none: false } }, userId),
    ).rejects.toThrow(/xc-perf/);
    await executeServerTool(memexId, "update_task", { ref, title: "Renamed" }, userId);
    expect(await taskVerdict(ref)).toEqual({ "xc-security": true, "xc-perf": false }); // untouched
  });
});

describe("update_decision edits a decision's facets in place, on any status (spec-445 dec-1, ac-6/ac-7)", () => {
  it("replaces the stored ballot and re-routes, and works on a RESOLVED decision (ac-6, ac-7)", async () => {
    tagAc(AC(6));
    tagAc(AC(7)); // status-independent — edits a resolved decision
    tagAc(AC(2)); // scope: replace whole verdict + re-surface standards (decision side)
    const ref = refOf(await executeServerTool(memexId, "create_decision", { ref: specRef, title: "Guard approach", context: "how", facetBallot: ballot(false, true) }, userId));
    await executeServerTool(memexId, "resolve_decision", { ref, resolution: "go" }, userId); // reuses the creation ballot
    expect(await decisionVerdict(ref)).toEqual({ "xc-security": false, "xc-perf": true });

    const out = await executeServerTool(memexId, "update_decision", { ref, facetBallot: ballot(true, false) }, userId);
    expect(out).toContain("std-1"); // re-routed on the new ballot, on a resolved decision
    expect(await decisionVerdict(ref)).toEqual({ "xc-security": true, "xc-perf": false }); // replaced in place
  });

  it("rejects combining a facet edit with a status transition (ac-6)", async () => {
    tagAc(AC(6));
    const ref = refOf(await executeServerTool(memexId, "create_decision", { ref: specRef, title: "Combine guard", context: "x", facetBallot: ballot(true, false) }, userId));
    await expect(
      executeServerTool(memexId, "update_decision", { ref, status: "open", facetBallot: ballot(false, true) }, userId),
    ).rejects.toThrow(/cannot combine/i);
  });
});

describe("no bespoke facet tool; a vocab-less Memex is a no-op (spec-445 dec-1, ac-7)", () => {
  it("adds NO facet-mutation tool to the manifest — the edit rides update_task / update_decision (ac-7)", () => {
    tagAc(AC(7));
    tagAc(AC(1)); // scope: no new facet-specific tool
    const names = toolManifest.map((t) => t.name);
    for (const banned of ["set_facets", "edit_facets", "change_facets", "assign_facets", "update_facets", "tag_facets"]) {
      expect(names).not.toContain(banned);
    }
    expect(toolManifest.find((t) => t.name === "update_task")!.args).toContain("facetBallot");
    expect(toolManifest.find((t) => t.name === "update_decision")!.args).toContain("facetBallot");
  });

  it("is a no-op on a Memex with no facet vocabulary — no ballot is stored, no error (ac-7)", async () => {
    tagAc(AC(7));
    const ref = refOf(await executeServerTool(bareMemexId, "create_task", { ref: bareSpecRef, title: "No-vocab task", description: "x" }, userId));
    await executeServerTool(bareMemexId, "update_task", { ref, facetBallot: { verdict: { "anything": true }, none: false } }, userId);
    const rows = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.memexId, bareMemexId));
    expect(rows).toHaveLength(0);
  });
});

describe("facets travel with a task/decision on retrieval, as read-only context (spec-445 dec-2, ac-8/ac-9)", () => {
  it("get_doc surfaces each task's and decision's facets; list_tasks includes the task's inline (ac-8)", async () => {
    tagAc(AC(8));
    tagAc(AC(3)); // scope: facets travel with the item on retrieval
    tagAc(AC(4)); // scope: a decision's facets are visible as context
    const tRef = refOf(await executeServerTool(memexId, "create_task", { ref: specRef, title: "Retrieval task", description: "x", facetBallot: ballot(true, false) }, userId));
    await executeServerTool(memexId, "create_decision", { ref: specRef, title: "Retrieval decision", context: "x", facetBallot: ballot(false, true) }, userId);

    // get_doc (verbose) renders a "Facets:" line for the task (security) and decision (perf).
    const docOut = await formatState("http://test", await fullDocState(memexId, specDocId));
    expect(docOut).toContain("Facets: xc-security");
    expect(docOut).toContain("Facets: xc-perf");

    // list_tasks surfaces the task's facets inline on its own ref line.
    const listOut = await executeServerTool(memexId, "list_tasks", { ref: specRef }, userId);
    const tLine = listOut.split("\n").find((l) => l.includes(tRef))!;
    expect(tLine).toContain("{facets: xc-security}");
  });

  it("a task with no ballot shows no facets (ac-8)", async () => {
    tagAc(AC(8));
    await executeServerTool(bareMemexId, "create_task", { ref: bareSpecRef, title: "Facetless task", description: "x" }, userId);
    const docOut = await formatState("http://test", await fullDocState(bareMemexId, bareSpecDocId));
    expect(docOut).not.toContain("Facets:");
    const listOut = await executeServerTool(bareMemexId, "list_tasks", { ref: bareSpecRef }, userId);
    expect(listOut).not.toContain("{facets:");
  });

  it("retrieval is read-only and never pre-fills; create_task still FORCES a fresh ballot (ac-9)", async () => {
    tagAc(AC(9));
    tagAc(AC(4)); // scope: visible context never biases the task's own forced ballot
    // get_doc creates/alters no ballot.
    const before = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.memexId, memexId));
    await executeServerTool(memexId, "get_doc", { ref: specRef, verbose: true }, userId);
    const after = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.memexId, memexId));
    expect(after.length).toBe(before.length);
    // No regression: create_task in a vocab Memex still hard-requires its own ballot —
    // a parent decision's visible facets never auto-fill it.
    await expect(
      executeServerTool(memexId, "create_task", { ref: specRef, title: "No ballot", description: "x" }, userId),
    ).rejects.toThrow(/facet ballot is REQUIRED/i);
  });
});
