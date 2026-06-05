import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

// Force dev-mode auth so app.request() can hit session-gated routes without minting a JWT.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { db } from "../db/connection.js";
import {
  documents,
  docSections,
  docComments,
  tasks,
} from "../db/schema.js";
import { app } from "../app.js";
import { createDocDraft } from "../services/documents.js";
import { createTask } from "../services/tasks.js";
import { createStandard, flagDrift } from "../services/standards.js";
import { createExecutionPlan } from "../services/execution_plans.js";
import { addTaskComment } from "../services/comments.js";
import { createDecision } from "../services/decisions.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";

// Path-based routing per std-2 / dec-3 of doc-15: memexResolver parses
// `/api/<ns-slug>/<memex-slug>/...` from the URL; the Host header is the apex
// `memex.ai`. hostGuard 404s arbitrary subdomains.
//
// makeTestMemexWithDevAdmin returns { memexId, slug } — slug is the namespace
// slug. The memex slug is always "main" (matches the helper's seed).

const createdDocIds: string[] = [];
const memexIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(docComments).where(eq(docComments.sectionId, id)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(docSections).where(eq(docSections.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
  if (memexIds.length) {
    const { memexes } = await import("../db/schema.js");
    await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
  }
});

let memexId: string;
let pathA: string;
let otherAccountId: string;
let pathB: string;

beforeAll(async () => {
  const a = await makeTestMemexWithDevAdmin("agg-a");
  memexId = a.memexId;
  pathA = `/api/${a.slug}/main`;
  memexIds.push(a.memexId);

  const b = await makeTestMemexWithDevAdmin("agg-b");
  otherAccountId = b.memexId;
  pathB = `/api/${b.slug}/main`;
  memexIds.push(b.memexId);
});

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

// ── /api/<ns>/<mx>/docs?type=standard&include=driftCount (W2) ──

describe("GET /api/<ns>/<mx>/docs?include=driftCount aggregate (t-19 W2)", () => {
  it("returns each standard with its open drift count in one round-trip", async () => {
    // Two standards: one with 2 open drift comments, one with none. Plus a non-standard
    // doc that should be filtered out by the type filter.
    const bpA = await createStandard(memexId, {
      title: "Drift Aggregate A",
      sections: [
        { sectionType: "do", content: "rule A1" },
        { sectionType: "verify", content: "rule A2" },
      ],
    });
    createdDocIds.push(bpA.id);
    const bpB = await createStandard(memexId, {
      title: "Drift Aggregate B (clean)",
      sections: [{ sectionType: "do", content: "rule B1" }],
    });
    createdDocIds.push(bpB.id);

    const spec = await createDocDraft(
      memexId,
      "Spec Sibling",
      "Purpose",
    );
    createdDocIds.push(spec.id);

    // 2 drift comments on bpA section 1 (one per section)
    const sectionA1 = bpA.sections[0];
    const sectionA2 = bpA.sections[1];
    await flagDrift(memexId, sectionA1.id, "first drift");
    await flagDrift(memexId, sectionA2.id, "second drift");

    const res = await app.request(
      `${pathA}/docs?type=standard&include=driftCount`,
      withApexHost(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      title: string;
      docType: string;
      driftCount?: number;
    }>;

    const a = body.find((d) => d.id === bpA.id);
    const b = body.find((d) => d.id === bpB.id);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.driftCount).toBe(2);
    expect(b!.driftCount).toBe(0);
    // Non-standard docs filtered out by ?type=standard
    expect(body.find((d) => d.id === spec.id)).toBeUndefined();
    expect(body.every((d) => d.docType === "standard")).toBe(true);
  });

  it("driftCount is omitted when ?include is not requested", async () => {
    const res = await app.request(`${pathA}/docs?type=standard`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ driftCount?: number }>;
    for (const d of body) {
      expect(d.driftCount).toBeUndefined();
    }
  });

  it("does not leak drift counts across memexes", async () => {
    // Account B has its own standard with no drift. Confirm B's response doesn't see
    // A's drift counts even though both queries hit the same table.
    const bpInB = await createStandard(otherAccountId, {
      title: "B-side Standard",
      sections: [{ sectionType: "do", content: "B rule 1" }],
    });
    createdDocIds.push(bpInB.id);

    const res = await app.request(
      `${pathB}/docs?type=standard&include=driftCount`,
      withApexHost(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; driftCount?: number }>;
    expect(body.length).toBe(1);
    expect(body[0].id).toBe(bpInB.id);
    expect(body[0].driftCount).toBe(0);
  });
});

// ── POST /api/<ns>/<mx>/execution-plans/readiness (W2) ──

describe("POST /api/<ns>/<mx>/execution-plans/readiness batched lookup (t-19 W2)", () => {
  it("returns plan + readiness for an array of task ids in one round-trip", async () => {
    const doc = await createDocDraft(memexId, "Plan Readiness Doc", "Purpose");
    createdDocIds.push(doc.id);

    // Three tasks: A has plan + READY readiness; B has plan but no readiness; C has
    // no plan at all.
    const itemA = await createTask(memexId, doc.id, "A", "with plan + ready");
    const itemB = await createTask(memexId, doc.id, "B", "with plan, no readiness");
    const itemC = await createTask(memexId, doc.id, "C", "no plan");

    await createExecutionPlan(memexId, itemA.id);
    await createExecutionPlan(memexId, itemB.id);
    await addTaskComment(
      memexId,
      itemA.id,
      "agent",
      "READY — all green",
      { type: "readiness_check", source: "agent" },
    );

    const res = await app.request(`${pathA}/execution-plans/readiness`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "memex.ai" },
      body: JSON.stringify({ taskIds: [itemA.id, itemB.id, itemC.id] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      taskId: string;
      executionPlanDocId: string | null;
      planStatus: string | null;
      readinessContent: string | null;
    }>;

    const a = body.find((e) => e.taskId === itemA.id)!;
    const b = body.find((e) => e.taskId === itemB.id)!;
    const c = body.find((e) => e.taskId === itemC.id)!;
    expect(a.executionPlanDocId).not.toBeNull();
    expect(a.planStatus).toBe("draft");
    expect(a.readinessContent).toMatch(/^READY/);
    expect(b.executionPlanDocId).not.toBeNull();
    expect(b.planStatus).toBe("draft");
    expect(b.readinessContent).toBeNull();
    expect(c.executionPlanDocId).toBeNull();
    expect(c.planStatus).toBeNull();
    expect(c.readinessContent).toBeNull();
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app.request(`${pathA}/execution-plans/readiness`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "memex.ai" },
      body: JSON.stringify({ taskIds: "not-an-array" }),
    });
    expect(res.status).toBe(400);
  });

  it("silently drops cross-account task ids (no leak)", async () => {
    const docInA = await createDocDraft(memexId, "ItemA Owner Doc", "Purpose");
    createdDocIds.push(docInA.id);
    const docInB = await createDocDraft(otherAccountId, "ItemB Owner Doc", "Purpose");
    createdDocIds.push(docInB.id);

    const itemInA = await createTask(memexId, docInA.id, "in A", "");
    const itemInB = await createTask(otherAccountId, docInB.id, "in B", "");

    // Caller in account A asks for both. Expect only itemInA returned.
    const res = await app.request(`${pathA}/execution-plans/readiness`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "memex.ai" },
      body: JSON.stringify({ taskIds: [itemInA.id, itemInB.id] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ taskId: string }>;
    expect(body.find((e) => e.taskId === itemInA.id)).toBeDefined();
    expect(body.find((e) => e.taskId === itemInB.id)).toBeUndefined();
  });
});

// ── GET /api/<ns>/<mx>/decisions/by-handle/:handle (t-20 W-A) ──

describe("GET /api/<ns>/<mx>/decisions/by-handle/:handle qualified handles + 409 (t-20 W-A)", () => {
  it("qualified `doc-N:dec-M` (URL-encoded colon) resolves to the right decision", async () => {
    const docA = await createDocDraft(memexId, "Q-A", "Purpose");
    const docB = await createDocDraft(memexId, "Q-B", "Purpose");
    createdDocIds.push(docA.id, docB.id);

    const decA = await createDecision(memexId, docA.id, "Choice in A");
    await createDecision(memexId, docB.id, "Choice in B");

    // Encode the colon — Hono URL-decodes the path param so the handler sees
    // `doc-N:dec-M` and getDecisionByHandle routes through the qualified path.
    const handle = `${docA.handle}:dec-${decA.seq}`;
    const res = await app.request(
      `${pathA}/decisions/by-handle/${encodeURIComponent(handle)}`,
      withApexHost(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; docId: string };
    expect(body.id).toBe(decA.id);
    expect(body.docId).toBe(docA.id);
  });

  it("bare `dec-N` with multiple matches returns 409 + candidates payload", async () => {
    const docX = await createDocDraft(memexId, "Q-X", "Purpose");
    const docY = await createDocDraft(memexId, "Q-Y", "Purpose");
    createdDocIds.push(docX.id, docY.id);

    // Both decisions get a per-doc seq starting at 1 → both produce dec-1 in
    // the same account. Bare lookup must return 409 with both qualified
    // candidates rather than silently picking one.
    await createDecision(memexId, docX.id, "X");
    await createDecision(memexId, docY.id, "Y");

    const res = await app.request(
      `${pathA}/decisions/by-handle/dec-1`,
      withApexHost(),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      code: string;
      candidates: string[];
    };
    expect(body.code).toBe("AMBIGUOUS_DECISION_HANDLE");
    expect(body.candidates).toEqual(
      expect.arrayContaining([`${docX.handle}:D-1`, `${docY.handle}:D-1`]),
    );
    // Candidates ordering is alphabetical for determinism.
    expect([...body.candidates].sort()).toEqual(body.candidates);
  });

  it("a sibling account's qualified handle does not leak (account scoping)", async () => {
    const docInOther = await createDocDraft(otherAccountId, "Other Q", "Purpose");
    createdDocIds.push(docInOther.id);
    const decInOther = await createDecision(otherAccountId, docInOther.id, "Other");

    const handle = `${docInOther.handle}:dec-${decInOther.seq}`;
    // Caller in `memexId` (not the owner) gets 404 — the owning doc handle
    // doesn't resolve under their account scope.
    const res = await app.request(
      `${pathA}/decisions/by-handle/${encodeURIComponent(handle)}`,
      withApexHost(),
    );
    expect(res.status).toBe(404);
  });

  // b-42 t-2 — `?docId=` query scopes the lookup to that parent doc. Lets the
  // React UI pass the local doc context for bare `dec-N` references so a memex
  // with multiple docs each having dec-1 doesn't 409 on every link click.
  it("bare `dec-N` with `?docId=` query scopes the lookup (b-42 t-2)", async () => {
    const docX = await createDocDraft(memexId, "Q-Xq", "Purpose");
    const docY = await createDocDraft(memexId, "Q-Yq", "Purpose");
    createdDocIds.push(docX.id, docY.id);

    const decX = await createDecision(memexId, docX.id, "X");
    await createDecision(memexId, docY.id, "Y");

    // Without ?docId=, this would 409 (same seq in two docs). With ?docId=
    // scoping to docX, the lookup resolves to decX without 409ing.
    const res = await app.request(
      `${pathA}/decisions/by-handle/dec-1?docId=${docX.id}`,
      withApexHost(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; docId: string };
    expect(body.id).toBe(decX.id);
    expect(body.docId).toBe(docX.id);
  });

  it("bare `dec-N` with `?docId=` query for the wrong doc returns 404 (b-42 t-2)", async () => {
    const docP = await createDocDraft(memexId, "Q-Pq", "Purpose");
    const docQ = await createDocDraft(memexId, "Q-Qq", "Purpose");
    createdDocIds.push(docP.id, docQ.id);

    await createDecision(memexId, docP.id, "P");
    // docQ has no decisions

    const res = await app.request(
      `${pathA}/decisions/by-handle/dec-1?docId=${docQ.id}`,
      withApexHost(),
    );
    expect(res.status).toBe(404);
  });
});

// b-42 t-2 — parallel by-handle endpoint for tasks gained `?docId=` query
// support to scope the lookup. Mirrors the decisions tests above; the React UI
// uses fetchTaskByHandle for `[per t-N]` link follow-through.
describe("GET /api/<ns>/<mx>/tasks/by-handle/:handle (b-42 t-2)", () => {
  it("bare `t-N` with `?docId=` query scopes the lookup", async () => {
    const docA = await createDocDraft(memexId, "T-Aq", "Purpose");
    const docB = await createDocDraft(memexId, "T-Bq", "Purpose");
    createdDocIds.push(docA.id, docB.id);

    const taskA = await createTask(memexId, docA.id, "Task in A", "");
    await createTask(memexId, docB.id, "Task in B", "");

    const res = await app.request(
      `${pathA}/tasks/by-handle/t-1?docId=${docA.id}`,
      withApexHost(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; docId: string };
    expect(body.id).toBe(taskA.id);
    expect(body.docId).toBe(docA.id);
  });

  it("bare `t-N` with `?docId=` query for the wrong doc returns 404", async () => {
    const docP = await createDocDraft(memexId, "T-Pq", "Purpose");
    const docQ = await createDocDraft(memexId, "T-Qq", "Purpose");
    createdDocIds.push(docP.id, docQ.id);

    await createTask(memexId, docP.id, "P", "");
    // docQ has no tasks

    const res = await app.request(
      `${pathA}/tasks/by-handle/t-1?docId=${docQ.id}`,
      withApexHost(),
    );
    expect(res.status).toBe(404);
  });
});

// ── listDocs parent projection (t-20 W-F) ──

describe("listDocs parent projection (t-20 W-F)", () => {
  it("populates `parent` on a spec promoted from a non-spec parent", async () => {
    // Generic non-spec doc to act as the parent.
    const generic = await createDocDraft(
      memexId,
      "Generic Parent (spec)",
      "Purpose",
      "spec",
    );
    createdDocIds.push(generic.id);

    // Promote into a spec + manually link parentDocId so the test doesn't
    // depend on `promoteToBrief` semantics around source-spec enforcement.
    const child = await createDocDraft(memexId, "Promoted Child", "Purpose", "spec");
    createdDocIds.push(child.id);
    await db
      .update(documents)
      .set({ parentDocId: generic.id })
      .where(eq(documents.id, child.id));

    const res = await app.request(`${pathA}/docs?type=spec`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      parentDocId: string | null;
      parent?: { id: string; handle: string; title: string; docType: string } | null;
    }>;

    const promoted = body.find((d) => d.id === child.id);
    expect(promoted).toBeDefined();
    expect(promoted!.parentDocId).toBe(generic.id);
    expect(promoted!.parent).toBeDefined();
    expect(promoted!.parent!.id).toBe(generic.id);
    expect(promoted!.parent!.title).toBe("Generic Parent (spec)");
    expect(promoted!.parent!.docType).toBe("spec");
  });
});
